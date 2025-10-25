// src/routes/ocorrencias.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ===================== utils ===================== */

const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

function normStr(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function toISO(d) {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date)) return null;
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Aceita YYYY-MM-DD, DD/MM/YYYY, ISO com hora, Date, timestamp (seg/ms) */
function toDateOrNull(input) {
  if (input == null) return null;

  // Date nativo
  if (input instanceof Date && !isNaN(input)) return fmt(input);

  const v = String(input).trim();
  if (!v) return null;

  // BR: DD/MM/YYYY
  const mBr = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mBr) return `${mBr[3]}-${mBr[2]}-${mBr[1]}`;

  // ISO (pega só a parte da data)
  const mIso = v.match(/^(\d{4}-\d{2}-\d{2})/);
  if (mIso) return mIso[1];

  // Timestamp (segundos ou ms)
  if (/^\d{10,13}$/.test(v)) {
    const ms = v.length === 13 ? Number(v) : Number(v) * 1000;
    const d = new Date(ms);
    return isNaN(d) ? null : fmt(d);
  }

  // Fallback: tentar parse do JS
  const d = new Date(v);
  return isNaN(d) ? null : fmt(d);

  function fmt(d) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }
}

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* === TIPOS permitidos & sanitização === */
const TIPOS_PERMITIDOS = ["FERIADO", "ATESTADO", "FALTA", "FOLGA", "OUTRO"];
const TIPOS_MSG = TIPOS_PERMITIDOS.join(", ");

function cleanTipo(input) {
  if (input == null) return null;
  const s = String(input).replace(/\\+/g, "").trim().toUpperCase();
  return TIPOS_PERMITIDOS.includes(s) ? s : null;
}

/* ===================== auth / escopo ===================== */

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
    if (!token)
      return res.status(401).json({ ok: false, error: "Não autenticado." });
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
  if (!empresas.length)
    throw new Error("Acesso negado (sem empresa vinculada).");

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
  if (!empresas.length)
    throw new Error("Acesso negado (sem empresa vinculada).");

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

/* ===================== middlewares ===================== */

router.use(requireAuth);

/* ===================== endpoints ===================== */

// GET /api/ocorrencias/tipos
router.get("/tipos", async (_req, res) => {
  return res.json({ ok: true, tipos: TIPOS_PERMITIDOS });
});

// GET /api/ocorrencias
router.get("/", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const empresasUser = dev ? [] : await getUserEmpresaIds(req.userId);

    const now = new Date();
    const padraoTo = toISO(now);
    const past = new Date(now);
    past.setDate(past.getDate() - 30);
    const padraoFrom = toISO(past);

    const from = toDateOrNull(req.query.from) || padraoFrom;
    const to = toDateOrNull(req.query.to) || padraoTo;

    const funcionarioId = req.query.funcionario_id
      ? Number(req.query.funcionario_id)
      : null;
    const tipoQuery = cleanTipo(req.query.tipo);
    const q = normStr(req.query.q);

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 200)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const params = [];

    // Usa DATE(o.data) para ficar robusto mesmo que a coluna seja DATETIME
    if (from) {
      where.push(`DATE(o.data) >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`DATE(o.data) <= ?`);
      params.push(to);
    }

    if (funcionarioId) {
      where.push(`o.funcionario_id = ?`);
      params.push(funcionarioId);
    }
    if (tipoQuery) {
      where.push(`o.tipo = ?`);
      params.push(tipoQuery);
    }

    if (q) {
      where.push(`(
         UPPER(o.tipo) LIKE UPPER(CONCAT('%',?,'%'))
      OR UPPER(o.obs)  LIKE UPPER(CONCAT('%',?,'%'))
      OR UPPER(p.nome) LIKE UPPER(CONCAT('%',?,'%'))
      )`);
      params.push(q, q, q);
    }

    if (!dev) {
      if (!empresasUser.length)
        return res.json({ ok: true, ocorrencias: [], total: 0 });
      where.push(
        `o.empresa_id IN (${empresasUser.map(() => "?").join(",")})`
      );
      params.push(...empresasUser);
    }

    const sqlBase = `
      FROM ocorrencias o
      JOIN funcionarios f ON f.id = o.funcionario_id
      JOIN pessoas p      ON p.id = f.pessoa_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    `;

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${sqlBase}`,
      params
    );

    const [rows] = await pool.query(
      `
      SELECT
        o.id, o.empresa_id, o.funcionario_id,
        DATE(o.data) AS data,  -- normaliza saída
        o.tipo, o.horas, o.obs,
        p.nome AS funcionario_nome
      ${sqlBase}
      ORDER BY DATE(o.data) DESC, o.id DESC
      LIMIT ? OFFSET ?
      `,
      [...params, limit, offset]
    );

    return res.json({ ok: true, ocorrencias: rows, total, limit, offset });
  } catch (e) {
    console.error("OCORRENCIAS_LIST_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao listar ocorrências." });
  }
});

// Valida e sanitiza payload
function validateOcorrenciaPayload({ funcionario_id, data, tipo, horas, obs }) {
  const funcionarioId = Number(funcionario_id);
  const dataISO = toDateOrNull(data);
  const tipoClean = cleanTipo(tipo);
  const horasVal = numOrNull(horas);
  const obsVal = normStr(obs);

  if (!funcionarioId || !dataISO) {
    throw new Error("Funcionário e data são obrigatórios.");
  }
  if (tipo != null && !tipoClean) {
    throw new Error(
      `Tipo inválido. Use um dos valores permitidos: ${TIPOS_MSG}.`
    );
  }

  return {
    funcionarioId,
    dataISO,
    tipoClean: tipoClean ?? null,
    horasVal,
    obsVal,
  };
}

// POST /api/ocorrencias
router.post("/", async (req, res) => {
  try {
    const { funcionarioId, dataISO, tipoClean, horasVal, obsVal } =
      validateOcorrenciaPayload(req.body || {});

    await ensureCanAccessFuncionario(req.userId, funcionarioId);

    const [[frow]] = await pool.query(
      `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
      [funcionarioId]
    );
    if (!frow)
      return res
        .status(404)
        .json({ ok: false, error: "Funcionário não encontrado." });

    const [ins] = await pool.query(
      `INSERT INTO ocorrencias
         (empresa_id, funcionario_id, data, tipo, horas, obs)
       VALUES (?,?,?,?,?,?)`,
      [frow.empresa_id, funcionarioId, dataISO, tipoClean, horasVal, obsVal]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("OCORRENCIAS_CREATE_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao criar ocorrência." });
  }
});

// PUT /api/ocorrencias/:id
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id)
      return res.status(400).json({ ok: false, error: "ID inválido." });

    await ensureCanAccessOcorrencia(req.userId, id);

    const sets = [];
    const params = [];

    if (req.body.funcionario_id != null) {
      const novoFuncionarioId = Number(req.body.funcionario_id);
      if (!novoFuncionarioId) throw new Error("Funcionário inválido.");
      await ensureCanAccessFuncionario(req.userId, novoFuncionarioId);
      const [[frow]] = await pool.query(
        `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
        [novoFuncionarioId]
      );
      if (!frow)
        return res
          .status(404)
          .json({ ok: false, error: "Funcionário não encontrado." });
      sets.push(`empresa_id = ?`);
      params.push(frow.empresa_id);
      sets.push(`funcionario_id = ?`);
      params.push(novoFuncionarioId);
    }

    if (req.body.data !== undefined) {
      const dataISO = toDateOrNull(req.body.data);
      if (!dataISO) throw new Error("Data inválida.");
      sets.push(`data = ?`);
      params.push(dataISO);
    }

    if (req.body.tipo !== undefined) {
      const t = cleanTipo(req.body.tipo);
      if (!t && req.body.tipo != null) {
        throw new Error(
          `Tipo inválido. Use um dos valores permitidos: ${TIPOS_MSG}.`
        );
      }
      sets.push(`tipo = ?`);
      params.push(t ?? null);
    }

    if (req.body.horas !== undefined) {
      const h = numOrNull(req.body.horas);
      sets.push(`horas = ?`);
      params.push(h);
    }

    if (req.body.obs !== undefined) {
      const o = normStr(req.body.obs);
      sets.push(`obs = ?`);
      params.push(o);
    }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);
    await pool.query(`UPDATE ocorrencias SET ${sets.join(", ")} WHERE id = ?`, params);

    return res.json({ ok: true });
  } catch (e) {
    console.error("OCORRENCIAS_UPDATE_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao atualizar ocorrência." });
  }
});

// DELETE /api/ocorrencias/:id
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id)
      return res.status(400).json({ ok: false, error: "ID inválido." });

    await ensureCanAccessOcorrencia(req.userId, id);
    await pool.query(`DELETE FROM ocorrencias WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("OCORRENCIAS_DELETE_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao excluir ocorrência." });
  }
});

export default router;