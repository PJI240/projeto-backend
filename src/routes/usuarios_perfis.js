// src/routes/usuarios_perfis.js
import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken";

const router = Router();

/* ===== Helper Auth ===== */
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
    "SELECT empresa_id FROM empresas_usuarios WHERE usuario_id = ? AND ativo = 1",
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

/* ===== GET: lista perfis de um usuário ===== */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const usuarioId = Number(req.query.usuario_id);
    if (!usuarioId) return res.status(400).json({ ok: false, error: "usuario_id é obrigatório." });

    const [rows] = await pool.query(
      `SELECT up.id, up.usuario_id, up.perfil_id, p.nome AS perfil_nome
         FROM usuarios_perfis up
         JOIN perfis p ON p.id = up.perfil_id
        WHERE up.usuario_id = ? AND up.empresa_id = ?`,
      [usuarioId, empresaId]
    );
    return res.json({ ok: true, empresa_id: empresaId, usuario_id: usuarioId, perfis: rows });
  } catch (e) {
    console.error("USUARIOS_PERFIS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar vínculos." });
  }
});

/* ===== POST: atribuir perfil a usuário ===== */
router.post("/", requireAuth, async (req, res) => {
  const { usuario_id, perfil_id } = req.body || {};
  if (!usuario_id || !perfil_id) {
    return res.status(400).json({ ok: false, error: "usuario_id e perfil_id são obrigatórios." });
  }

  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Perfil pertence à empresa?
    const [[pOk]] = await conn.query(
      "SELECT id FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1",
      [perfil_id, empresaId]
    );
    if (!pOk) throw new Error("Perfil inválido para esta empresa.");

    await conn.query(
      `INSERT INTO usuarios_perfis (empresa_id, usuario_id, perfil_id)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE perfil_id = VALUES(perfil_id)`,
      [empresaId, usuario_id, perfil_id]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("USUARIOS_PERFIS_SAVE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao salvar vínculo." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===== DELETE: remover vínculo ===== */
router.delete("/", requireAuth, async (req, res) => {
  const { usuario_id, perfil_id } = req.body || {};
  if (!usuario_id || !perfil_id) {
    return res.status(400).json({ ok: false, error: "usuario_id e perfil_id são obrigatórios." });
  }

  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await conn.query(
      `DELETE FROM usuarios_perfis WHERE empresa_id = ? AND usuario_id = ? AND perfil_id = ?`,
      [empresaId, usuario_id, perfil_id]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("USUARIOS_PERFIS_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao remover vínculo." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
