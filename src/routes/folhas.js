// src/routes/folhas.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ======================= helpers ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => {
  const s = norm(v);
  return s.length ? s : null;
};
const onlyYM = (s) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : null;
};

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
async function getFirstEmpresaForUser(userId) {
  const [[row]] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1
      ORDER BY eu.empresa_id ASC
      LIMIT 1`,
    [userId]
  );
  return row?.empresa_id ?? null;
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

async function ensureFolhaScope(userId, folhaId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Acesso negado (sem empresa vinculada).");
  const [[row]] = await pool.query(`SELECT empresa_id FROM folhas WHERE id = ? LIMIT 1`, [folhaId]);
  if (!row) throw new Error("Folha não encontrada.");
  if (!empresas.includes(Number(row.empresa_id))) throw new Error("Recurso fora do escopo do usuário.");
  return true;
}

/* ======================= rotas ======================= */

router.use(requireAuth);

/**
 * GET /api/folhas?scope=mine|all&from=YYYY-MM&to=YYYY-MM&q=&status=ABERTA|FECHADA
 */
router.get("/folhas", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    const scope = String(req.query.scope || "mine").toLowerCase();
    const from = onlyYM(req.query.from);
    const to = onlyYM(req.query.to);
    const q = normStr(req.query.q);
    const status = normStr(req.query.status)?.toUpperCase();

    const where = [];
    const params = [];

    if (!dev || scope !== "all") {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length) return res.json({ ok: true, folhas: [], scope: "mine" });
      where.push(`f.empresa_id IN (${empresas.map(() => "?").join(",")})`);
      params.push(...empresas);
    }

    if (from) {
      where.push(`f.competencia >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`f.competencia <= ?`);
      params.push(to);
    }
    if (status && status !== "TODOS") {
      where.push(`UPPER(f.status) = ?`);
      params.push(status);
    }
    if (q) {
      where.push(`(
        f.competencia LIKE CONCAT('%',?,'%')
        OR UPPER(f.status) LIKE UPPER(CONCAT('%',?,'%'))
        OR CAST(f.id AS CHAR) LIKE CONCAT('%',?,'%')
      )`);
      params.push(q, q, q);
    }

    const [rows] = await pool.query(
      `SELECT f.id, f.empresa_id, f.competencia, f.status
         FROM folhas f
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY f.competencia DESC, f.id DESC`,
      params
    );

    return res.json({ ok: true, folhas: rows, scope: dev && scope === "all" ? "all" : "mine" });
  } catch (e) {
    console.error("FOLHAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar folhas." });
  }
});

/**
 * GET /api/folhas/:id
 */
router.get("/folhas/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaScope(req.userId, id);

    const [[row]] = await pool.query(
      `SELECT f.id, f.empresa_id, f.competencia, f.status
         FROM folhas f
        WHERE f.id = ?
        LIMIT 1`,
      [id]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Folha não encontrada." });

    return res.json({ ok: true, folha: row });
  } catch (e) {
    console.error("FOLHA_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao obter folha." });
  }
});

/**
 * POST /api/folhas
 * body: { competencia:'YYYY-MM', status:'ABERTA'|'FECHADA', empresa_id? }
 */
router.post("/folhas", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    const competencia = onlyYM(req.body?.competencia);
    const status = (normStr(req.body?.status) || "ABERTA").toUpperCase();
    let empresa_id = req.body?.empresa_id ? Number(req.body.empresa_id) : null;

    if (!competencia) return res.status(400).json({ ok: false, error: "Competência inválida (YYYY-MM)." });
    if (!["ABERTA", "FECHADA"].includes(status)) {
      return res.status(400).json({ ok: false, error: "Status inválido (ABERTA|FECHADA)." });
    }

    if (!empresa_id) {
      // se não veio empresa, usa a primeira vinculada ao usuário (não-dev)
      if (!dev) {
        empresa_id = await getFirstEmpresaForUser(req.userId);
        if (!empresa_id) return res.status(403).json({ ok: false, error: "Usuário sem empresa vinculada." });
      } else {
        return res.status(400).json({ ok: false, error: "Informe empresa_id (desenvolvedor)." });
      }
    } else if (!dev) {
      // usuário comum só pode criar na(s) sua(s) empresa(s)
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.includes(Number(empresa_id))) {
        return res.status(403).json({ ok: false, error: "Empresa fora do escopo do usuário." });
      }
    }

    // evita duplicidade de competência por empresa
    const [[dupe]] = await pool.query(
      `SELECT id FROM folhas WHERE empresa_id = ? AND competencia = ? LIMIT 1`,
      [empresa_id, competencia]
    );
    if (dupe) return res.status(409).json({ ok: false, error: "Competência já cadastrada para esta empresa." });

    const [ins] = await pool.query(
      `INSERT INTO folhas (empresa_id, competencia, status)
       VALUES (?,?,?)`,
      [empresa_id, competencia, status]
    );
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("FOLHA_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar folha." });
  }
});

/**
 * PUT /api/folhas/:id
 * body: { competencia?, status? }
 */
router.put("/folhas/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaScope(req.userId, id);

    const sets = [];
    const params = [];

    if (req.body?.competencia !== undefined) {
      const v = onlyYM(req.body.competencia);
      if (!v) return res.status(400).json({ ok: false, error: "Competência inválida (YYYY-MM)." });
      sets.push("competencia = ?");
      params.push(v);
    }
    if (req.body?.status !== undefined) {
      const st = String(req.body.status || "").toUpperCase();
      if (!["ABERTA", "FECHADA"].includes(st)) {
        return res.status(400).json({ ok: false, error: "Status inválido (ABERTA|FECHADA)." });
      }
      sets.push("status = ?");
      params.push(st);
    }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);
    await pool.query(`UPDATE folhas SET ${sets.join(", ")} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (e) {
    console.error("FOLHA_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar folha." });
  }
});

/**
 * DELETE /api/folhas/:id
 */
router.delete("/folhas/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaScope(req.userId, id);

    try {
      await pool.query(`DELETE FROM folhas WHERE id = ?`, [id]);
    } catch (err) {
      // FK impedindo exclusão
      if (err?.code === "ER_ROW_IS_REFERENCED_2" || err?.errno === 1451) {
        return res.status(409).json({
          ok: false,
          error: "Não é possível excluir: existem registros vinculados (folhas_funcionarios/itens).",
        });
      }
      throw err;
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("FOLHA_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir folha." });
  }
});

export default router;