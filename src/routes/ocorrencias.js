// src/routes/ocorrencias.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ===================== helpers genéricos ===================== */

const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

function normStr(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function toDateOrNull(s) {
  const v = normStr(s);
  if (!v) return null;
  // aceita "YYYY-MM-DD" ou "DD/MM/YYYY"
  const mIso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mBr  = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mIso) return v;
  if (mBr) return `${mBr[3]}-${mBr[2]}-${mBr[1]}`;
  return null;
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ===================== helpers auth/scope ===================== */

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => String(r.perfil || "").toLowerCase());
}

function isDev(roles = []) {
  return roles.map((r) => String(r).toLowerCase()).includes("desenvolvedor");
}

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

async function ensureCanAccessFuncionario(userId, funcionarioId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Acesso negado (sem empresa vinculada).");

  // conferir empresa do funcionário
  const [[row]] = await pool.query(
    `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
    [funcionarioId]
  );
  if (!row) throw new Error("Funcionário não encontrado.");
  if (empresas.includes(Number(row.empresa_id))) return true;

  throw new Error("Funcionário fora do escopo do usuário.");
}

async function ensureCanAccessOcorrencia(userId, ocorrenciaId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Acesso negado (sem empresa vinculada).");

  // obtém empresa via join na ocorrência
  const [[row]] = await pool.query(
    `SELECT o.empresa_id
       FROM ocorrencias o
      WHERE o.id = ?
      LIMIT 1`,
    [ocorrenciaId]
  );
  if (!row) throw new Error("Ocorrência não encontrada.");
  if (empresas.includes(Number(row.empresa_id))) return true;

  throw new Error("Ocorrência fora do escopo do usuário.");
}

/* =========================================================
   ROTAS PROTEGIDAS
   ========================================================= */

router.use(requireAuth);

/**
 * GET /api/ocorrencias
 * Query params:
 *  - from, to (datas) — default: últimos 30 dias
 *  - funcionario_id
 *  - tipo
 *  - q (busca em nome/obs/tipo)
 *  - limit, offset (paginação)
 */
router.get("/", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const empresasUser = dev ? [] : await getUserEmpresaIds(req.userId);

    // período padrão = últimos 30 dias
    const now = new Date();
    const padraoTo   = toDateOrNull(`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`);
    const past       = new Date(now); past.setDate(past.getDate() - 30);
    const padraoFrom = toDateOrNull(`${past.getFullYear()}-${String(past.getMonth()+1).padStart(2,"0")}-${String(past.getDate()).padStart(2,"0")}`);

    const from = toDateOrNull(req.query.from) || padraoFrom;
    const to   = toDateOrNull(req.query.to)   || padraoTo;

    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const tipo = normStr(req.query.tipo);
    const q    = normStr(req.query.q);

    const limit  = Math.min(200, Math.max(1, Number(req.query.limit || 200)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const params = [];

    if (from) { where.push(`o.data >= ?`); params.push(from); }
    if (to)   { where.push(`o.data <= ?`); params.push(to); }

    if (funcionarioId) { where.push(`o.funcionario_id = ?`); params.push(funcionarioId); }
    if (tipo)          { where.push(`UPPER(o.tipo) = UPPER(?)`); params.push(tipo); }

    if (q) {
      where.push(`(
         UPPER(o.tipo) LIKE UPPER(CONCAT('%',?,'%'))
      OR UPPER(o.obs)  LIKE UPPER(CONCAT('%',?,'%'))
      OR UPPER(p.nome) LIKE UPPER(CONCAT('%',?,'%'))
      )`);
      params.push(q, q, q);
    }

    // escopo por empresa (se não-dev)
    if (!dev) {
      if (!empresasUser.length) return res.json({ ok: true, ocorrencias: [], total: 0 });
      where.push(`o.empresa_id IN (${empresasUser.map(() => "?").join(",")})`);
      params.push(...empresasUser);
    }

    const sqlBase = `
      FROM ocorrencias o
      JOIN funcionarios f ON f.id = o.funcionario_id
      JOIN pessoas p      ON p.id = f.pessoa_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    `;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${sqlBase}`, params);

    const [rows] = await pool.query(
      `
      SELECT
        o.id, o.empresa_id, o.funcionario_id, o.data, o.tipo, o.horas, o.obs,
        p.nome AS funcionario_nome
      ${sqlBase}
      ORDER BY o.data DESC, o.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({ ok: true, ocorrencias: rows, total, limit, offset });
  } catch (e) {
    console.error("OCORRENCIAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar ocorrências." });
  }
});

/**
 * POST /api/ocorrencias
 * body: { funcionario_id, data, tipo, horas, obs }
 */
router.post("/", async (req, res) => {
  try {
    const funcionario_id = Number(req.body?.funcionario_id);
    const data = toDateOrNull(req.body?.data);
    const tipo = normStr(req.body?.tipo);
    const horas = numOrNull(req.body?.horas);
    const obs = normStr(req.body?.obs);

    if (!funcionario_id || !data) {
      return res.status(400).json({ ok: false, error: "funcionário e data são obrigatórios." });
    }

    await ensureCanAccessFuncionario(req.userId, funcionario_id);

    // empresa do funcionário
    const [[frow]] = await pool.query(
      `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
      [funcionario_id]
    );
    if (!frow) return res.status(404).json({ ok: false, error: "Funcionário não encontrado." });

    const [ins] = await pool.query(
      `INSERT INTO ocorrencias
         (empresa_id, funcionario_id, data, tipo, horas, obs)
       VALUES (?,?,?,?,?,?)`,
      [frow.empresa_id, funcionario_id, data, tipo || null, horas, obs]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("OCORRENCIAS_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar ocorrência." });
  }
});

/**
 * PUT /api/ocorrencias/:id
 * body: { funcionario_id, data, tipo, horas, obs }
 * - permite trocar o funcionário (revalida escopo e recalcula empresa_id)
 */
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    // se trocar o funcionário, precisa poder acessá-lo
    const novoFuncionarioId = req.body?.funcionario_id ? Number(req.body.funcionario_id) : null;
    const data = toDateOrNull(req.body?.data);
    const tipo = normStr(req.body?.tipo);
    const horas = numOrNull(req.body?.horas);
    const obs = normStr(req.body?.obs);

    // garante que a ocorrência atual está no escopo
    await ensureCanAccessOcorrencia(req.userId, id);

    let empresaIdAlvo = null;
    let funcionarioIdAlvo = null;

    if (novoFuncionarioId) {
      await ensureCanAccessFuncionario(req.userId, novoFuncionarioId);
      const [[frow]] = await pool.query(`SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`, [novoFuncionarioId]);
      if (!frow) return res.status(404).json({ ok: false, error: "Funcionário não encontrado." });
      empresaIdAlvo = frow.empresa_id;
      funcionarioIdAlvo = novoFuncionarioId;
    }

    // monta update dinâmico
    const sets = [];
    const params = [];
    if (empresaIdAlvo != null) { sets.push(`empresa_id = ?`); params.push(empresaIdAlvo); }
    if (funcionarioIdAlvo != null) { sets.push(`funcionario_id = ?`); params.push(funcionarioIdAlvo); }
    if (data != null) { sets.push(`data = ?`); params.push(data); }
    if (req.body?.tipo !== undefined) { sets.push(`tipo = ?`); params.push(tipo); }
    if (req.body?.horas !== undefined) { sets.push(`horas = ?`); params.push(horas); }
    if (req.body?.obs !== undefined) { sets.push(`obs = ?`); params.push(obs); }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);

    await pool.query(`UPDATE ocorrencias SET ${sets.join(", ")} WHERE id = ?`, params);

    return res.json({ ok: true });
  } catch (e) {
    console.error("OCORRENCIAS_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar ocorrência." });
  }
});

/**
 * DELETE /api/ocorrencias/:id
 */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    await ensureCanAccessOcorrencia(req.userId, id);

    await pool.query(`DELETE FROM ocorrencias WHERE id = ?`, [id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("OCORRENCIAS_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir ocorrência." });
  }
});

export default router;