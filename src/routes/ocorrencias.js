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

function normTipo(v) {
  const s = normStr(v);
  return s ? s.toUpperCase() : null;
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

/* ===================== validação dinâmica via CHECK do banco ===================== */

// cache simples pra não consultar o INFORMATION_SCHEMA toda hora
let _ocChkCache = { tipos: null, hasMinHoras0: null, maxHoras: null, loadedAt: 0 };

async function loadOcorrenciasCheckInfo() {
  const now = Date.now();
  if (_ocChkCache.loadedAt && now - _ocChkCache.loadedAt < 5 * 60 * 1000) return _ocChkCache;

  // Em MySQL/MariaDB, TABLE_NAME não está em CHECK_CONSTRAINTS.
  // Precisamos JOIN com TABLE_CONSTRAINTS e filtrar pelo schema atual (DATABASE()).
  const [rows] = await pool.query(
    `
    SELECT cc.CHECK_CLAUSE
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
        ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND cc.CONSTRAINT_NAME  = tc.CONSTRAINT_NAME
     WHERE tc.TABLE_SCHEMA = DATABASE()
       AND tc.TABLE_NAME   = 'ocorrencias'
       AND tc.CONSTRAINT_TYPE = 'CHECK'
     ORDER BY tc.CONSTRAINT_NAME ASC
    `
  );

  const tipos = new Set();
  let hasMinHoras0 = false;
  let maxHoras = null;

  for (const r of rows) {
    const clause = String(r.CHECK_CLAUSE || "");

    // Extrai lista de tipos do IN(...)
    const mIn = clause.match(/`?tipo`?\s*in\s*\(([^)]+)\)/i);
    if (mIn) {
      const inner = mIn[1];
      const reStr = /'([^']+)'/g;
      let mm;
      while ((mm = reStr.exec(inner))) {
        tipos.add(mm[1]); // mantém como definido no CHECK (geralmente MAIÚSCULO)
      }
    }

    // horas >= 0
    if (/`?horas`?\s*>=\s*0/i.test(clause)) hasMinHoras0 = true;

    // horas <= X (se existir)
    const mMax = clause.match(/`?horas`?\s*<=\s*(\d+(?:\.\d+)?)/i);
    if (mMax) {
      const v = Number(mMax[1]);
      if (Number.isFinite(v)) maxHoras = maxHoras == null ? v : Math.min(maxHoras, v);
    }
  }

  _ocChkCache = {
    tipos: tipos.size ? tipos : null,
    hasMinHoras0,
    maxHoras,
    loadedAt: now,
  };

  return _ocChkCache;
}

// Lança erro amigável quando payload viola o CHECK
async function validateOcorrenciaPayload({ tipo, horas }) {
  const chk = await loadOcorrenciasCheckInfo();

  if (chk.tipos) {
    if (!tipo || !chk.tipos.has(tipo)) {
      const lista = Array.from(chk.tipos).join(", ");
      throw new Error(`Tipo inválido. Use um dos valores permitidos: ${lista}.`);
    }
  } else {
    // fallback: se não conseguimos detectar a lista, ao menos exigir não-nulo
    if (!tipo) throw new Error("Tipo é obrigatório.");
  }

  if (horas != null) {
    if (chk.hasMinHoras0 && horas < 0) {
      throw new Error("Horas não pode ser negativa.");
    }
    if (chk.maxHoras != null && horas > chk.maxHoras) {
      throw new Error(`Horas acima do limite permitido (${chk.maxHoras}).`);
    }
  }
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
    const tipo = normTipo(req.query.tipo);
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
      if (!empresasUser.length) return res.json({ ok: true, ocorrencias: [], total: 0, limit, offset });
      where.push(`o.empresa_id IN (${empresasUser.map(() => "?").join(",")})`);
      params.push(...empresasUser);
    }

    const sqlBase = `
      FROM ocorrencias o
      JOIN funcionarios f ON f.id = o.funcionario_id
      JOIN pessoas p      ON p.id = f.pessoa_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    `;

    const [[cnt]] = await pool.query(`SELECT COUNT(*) AS total ${sqlBase}`, params);
    const total = Number(cnt?.total || 0);

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
    const tipo = normTipo(req.body?.tipo);
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

    // validação alinhada ao CHECK do banco
    await validateOcorrenciaPayload({ tipo, horas });

    const [ins] = await pool.query(
      `INSERT INTO ocorrencias
         (empresa_id, funcionario_id, data, tipo, horas, obs)
       VALUES (?,?,?,?,?,?)`,
      [frow.empresa_id, funcionario_id, data, tipo, horas, obs]
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

    // garante que a ocorrência atual está no escopo
    await ensureCanAccessOcorrencia(req.userId, id);

    // se trocar o funcionário, precisa poder acessá-lo
    const novoFuncionarioId = req.body?.funcionario_id ? Number(req.body.funcionario_id) : null;
    const data = toDateOrNull(req.body?.data);
    const tipoReq = (req.body?.tipo !== undefined) ? normTipo(req.body.tipo) : undefined; // undefined => não alterar
    const horasReq = (req.body?.horas !== undefined) ? numOrNull(req.body.horas) : undefined;
    const obs = (req.body?.obs !== undefined) ? normStr(req.body.obs) : undefined;

    let empresaIdAlvo = null;
    let funcionarioIdAlvo = null;

    if (novoFuncionarioId) {
      await ensureCanAccessFuncionario(req.userId, novoFuncionarioId);
      const [[frow]] = await pool.query(`SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`, [novoFuncionarioId]);
      if (!frow) return res.status(404).json({ ok: false, error: "Funcionário não encontrado." });
      empresaIdAlvo = frow.empresa_id;
      funcionarioIdAlvo = novoFuncionarioId;
    }

    // valida (usa estado atual para compor o conjunto final válido)
    if (tipoReq !== undefined || horasReq !== undefined) {
      const [[curr]] = await pool.query(`SELECT tipo, horas FROM ocorrencias WHERE id = ?`, [id]);
      if (!curr) return res.status(404).json({ ok: false, error: "Ocorrência não encontrada." });

      const tipoFinal = (tipoReq !== undefined) ? tipoReq : (curr.tipo ? String(curr.tipo).toUpperCase() : null);
      const horasFinal = (horasReq !== undefined) ? horasReq : curr.horas;

      await validateOcorrenciaPayload({ tipo: tipoFinal, horas: horasFinal });
    }

    // monta update dinâmico
    const sets = [];
    const params = [];
    if (empresaIdAlvo != null) { sets.push(`empresa_id = ?`); params.push(empresaIdAlvo); }
    if (funcionarioIdAlvo != null) { sets.push(`funcionario_id = ?`); params.push(funcionarioIdAlvo); }
    if (data != null) { sets.push(`data = ?`); params.push(data); }
    if (tipoReq !== undefined) { sets.push(`tipo = ?`); params.push(tipoReq); }
    if (horasReq !== undefined) { sets.push(`horas = ?`); params.push(horasReq); }
    if (obs !== undefined) { sets.push(`obs = ?`); params.push(obs); }

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

/**
 * (Opcional) GET /api/ocorrencias/tipos
 * expõe a whitelist de tipos (lida do CHECK) para montar selects no front
 */
router.get("/tipos", async (req, res) => {
  try {
    const chk = await loadOcorrenciasCheckInfo();
    const tipos = chk.tipos ? Array.from(chk.tipos).sort() : [];
    res.json({ ok: true, tipos, minHoras0: !!chk.hasMinHoras0, maxHoras: chk.maxHoras });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Falha ao obter tipos." });
  }
});

export default router;
