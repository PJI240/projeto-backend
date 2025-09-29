// src/routes/cargos.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===== helpers ===== */

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");
  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
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

/* ===== rotas ===== */

// GET /api/cargos
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const [rows] = await pool.query(
      `SELECT id, nome, descricao, ativo
         FROM cargos
        WHERE empresa_id = ?
        ORDER BY nome ASC`,
      [empresaId]
    );
    return res.json({ ok: true, empresa_id: empresaId, cargos: rows });
  } catch (e) {
    console.error("CARGOS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar cargos." });
  }
});

// POST /api/cargos
router.post("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { nome, descricao = "", ativo = 1 } = req.body || {};
    if (!String(nome || "").trim()) {
      return res.status(400).json({ ok: false, error: "Nome é obrigatório." });
    }

    const [ins] = await pool.query(
      `INSERT INTO cargos (empresa_id, nome, descricao, ativo)
       VALUES (?,?,?,?)`,
      [empresaId, nome.trim(), descricao || null, ativo ? 1 : 0]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("CARGOS_CREATE_ERR", e);
    // trata UNIQUE (empresa_id, nome)
    if (String(e.code) === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Já existe um cargo com este nome nesta empresa." });
    }
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar cargo." });
  }
});

// PUT /api/cargos/:id
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    const { nome, descricao = "", ativo = 1 } = req.body || {};

    // valida pertencimento
    const [[okRow]] = await pool.query(
      `SELECT 1 FROM cargos WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!okRow) return res.status(404).json({ ok: false, error: "Cargo não encontrado na empresa." });

    await pool.query(
      `UPDATE cargos
          SET nome = ?, descricao = ?, ativo = ?
        WHERE id = ?`,
      [nome?.trim() || null, descricao || null, ativo ? 1 : 0, id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("CARGOS_UPDATE_ERR", e);
    if (String(e.code) === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Já existe um cargo com este nome nesta empresa." });
    }
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar cargo." });
  }
});

// DELETE /api/cargos/:id
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // valida pertencimento
    const [[okRow]] = await pool.query(
      `SELECT 1 FROM cargos WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!okRow) return res.status(404).json({ ok: false, error: "Cargo não encontrado na empresa." });

    await pool.query(`DELETE FROM cargos WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("CARGOS_DELETE_ERR", e);
    // Pode falhar se existir funcionário vinculado a este cargo (FK)
    return res.status(400).json({
      ok: false,
      error:
        e.code === "ER_ROW_IS_REFERENCED_2"
          ? "Não é possível excluir: há funcionários vinculados a este cargo."
          : e.message || "Falha ao excluir cargo.",
    });
  }
});

export default router;
