// src/routes/permissoes.js
import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken";

const router = Router();

export const PERMISSIONS_REGISTRY = [
  { codigo: "menu.dashboard.ver", descricao: "Ver Dashboard", escopo: "ui" },
  { codigo: "menu.usuarios.ver", descricao: "Ver Usuários", escopo: "ui" },
  { codigo: "menu.pessoas.ver", descricao: "Ver Pessoas", escopo: "ui" },
  { codigo: "menu.empresas.ver", descricao: "Ver Empresas", escopo: "ui" },
  { codigo: "menu.perfis.ver", descricao: "Ver Perfis", escopo: "ui" },
  { codigo: "menu.permissoes.ver", descricao: "Ver Permissões", escopo: "ui" },
  { codigo: "menu.cargos.ver", descricao: "Ver Cargos", escopo: "ui" },
  { codigo: "menu.funcionarios.ver", descricao: "Ver Funcionários", escopo: "ui" },
  { codigo: "usuarios.criar", descricao: "Criar usuário", escopo: "api" },
  { codigo: "usuarios.editar", descricao: "Editar usuário", escopo: "api" },
  { codigo: "usuarios.excluir", descricao: "Excluir usuário", escopo: "api" },
  { codigo: "pessoas.criar", descricao: "Criar pessoa", escopo: "api" },
  { codigo: "pessoas.editar", descricao: "Editar pessoa", escopo: "api" },
  { codigo: "pessoas.excluir", descricao: "Excluir pessoa", escopo: "api" },
  // adicione aqui outras permissões conforme expandir o sistema
];

/* ===== Helper para autenticação básica ===== */
function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

/* ===== GET /api/permissoes ===== */
router.get("/", requireAuth, async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, codigo, descricao, escopo FROM permissoes ORDER BY codigo ASC"
    );
    return res.json({ ok: true, permissoes: rows });
  } catch (e) {
    console.error("PERMISSOES_LIST_ERR", e);
    return res.status(500).json({ ok: false, error: "Falha ao listar permissões." });
  }
});

/* ===== POST /api/permissoes/sync =====
   Faz upsert das permissões definidas em PERMISSIONS_REGISTRY.
*/
router.post("/sync", requireAuth, async (_req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    let upserted = 0;
    for (const perm of PERMISSIONS_REGISTRY) {
      const { codigo, descricao, escopo } = perm;
      const [r] = await conn.query(
        `INSERT INTO permissoes (codigo, descricao, escopo)
         VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE
           descricao = VALUES(descricao),
           escopo = VALUES(escopo)`,
        [codigo, descricao, escopo]
      );
      upserted += r.affectedRows;
    }

    await conn.commit();
    return res.json({ ok: true, upserted });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("PERMISSOES_SYNC_ERR", e);
    return res.status(500).json({ ok: false, error: "Falha ao sincronizar permissões." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
