// src/routes/perfis.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { isAdminName, ensureAdminProfile } from "../lib/roles.js";

const router = Router();

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

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id FROM empresas_usuarios WHERE usuario_id = ? AND ativo = 1`,
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

// GET /api/perfis
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const [rows] = await pool.query(
      `SELECT id, nome, ativo FROM perfis WHERE empresa_id = ? ORDER BY nome ASC`,
      [empresaId]
    );
    return res.json({ ok: true, empresa_id: empresaId, perfis: rows });
  } catch (e) {
    console.error("PERFIS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar perfis." });
  }
});

// POST /api/perfis
router.post("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const nome = String(req.body?.nome || "").trim();
    if (!nome) return res.status(400).json({ ok: false, error: "Nome é obrigatório." });
    if (isAdminName(nome)) {
      await ensureAdminProfile(empresaId);
      return res.json({ ok: true }); // já existe/ativado
    }
    const [ins] = await pool.query(
      `INSERT INTO perfis (empresa_id, nome, ativo) VALUES (?,?,1)`,
      [empresaId, nome]
    );
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("PERFIS_CREATE_ERR", e);
    const msg = /Duplicate entry/i.test(String(e?.message || "")) ? "Já existe um perfil com esse nome." : "Falha ao criar perfil.";
    return res.status(400).json({ ok: false, error: msg });
  }
});

// PUT /api/perfis/:id  (não permite renomear “Administrador”)
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    const nome = String(req.body?.nome || "").trim();
    const ativo = req.body?.ativo ? 1 : 0;

    const [[p]] = await pool.query(
      `SELECT id, nome FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!p) return res.status(404).json({ ok: false, error: "Perfil não encontrado." });

    if (isAdminName(p.nome)) {
      // Pode apenas reativar (ativo=1). Não pode renomear nem desativar.
      if (ativo !== 1) return res.status(400).json({ ok: false, error: "O perfil Administrador não pode ser desativado." });
      await pool.query(`UPDATE perfis SET ativo = 1 WHERE id = ?`, [id]);
      return res.json({ ok: true });
    }

    await pool.query(
      `UPDATE perfis SET nome = ?, ativo = ? WHERE id = ?`,
      [nome || p.nome, ativo, id]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("PERFIS_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar perfil." });
  }
});

// DELETE /api/perfis/:id (bloqueia Administrador)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    const [[p]] = await pool.query(
      `SELECT id, nome FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!p) return res.status(404).json({ ok: false, error: "Perfil não encontrado." });
    if (isAdminName(p.nome)) {
      return res.status(400).json({ ok: false, error: "O perfil Administrador não pode ser excluído." });
    }

    await pool.query(`DELETE FROM perfis WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("PERFIS_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir perfil." });
  }
});

export default router;