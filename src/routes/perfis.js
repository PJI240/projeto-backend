// src/routes/perfis.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===== helpers ===== */
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
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

/** Resolve empresa corrente (id passado e permitido, ou a 1ª do usuário) */
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

/* ===== Rotas ===== */

/**
 * GET /api/perfis?empresa_id=OPC
 * Lista perfis da empresa de contexto.
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const [rows] = await pool.query(
      `SELECT id, nome, ativo
         FROM perfis
        WHERE empresa_id = ?
        ORDER BY nome ASC`,
      [empresaId]
    );
    return res.json({ ok: true, empresa_id: empresaId, perfis: rows });
  } catch (e) {
    console.error("PERFIS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar perfis." });
  }
});

export default router;
