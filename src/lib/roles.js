// src/lib/roles.js
import { pool } from "../db.js";

export const ADMIN_NAME = "Administrador";

export function isAdminName(s = "") {
  return String(s).trim().toLowerCase() === "administrador";
}

export async function ensureAdminProfile(empresaId) {
  // cria se não existe
  const [[p]] = await pool.query(
    `SELECT id, ativo FROM perfis WHERE empresa_id = ? AND LOWER(nome) = 'administrador' LIMIT 1`,
    [empresaId]
  );
  if (!p) {
    const [ins] = await pool.query(
      `INSERT INTO perfis (empresa_id, nome, ativo) VALUES (?,?,1)`,
      [empresaId, ADMIN_NAME]
    );
    return ins.insertId;
  }
  if (p.ativo !== 1) {
    await pool.query(`UPDATE perfis SET ativo = 1 WHERE id = ?`, [p.id]);
  }
  return p.id;
}

export async function getAdminProfileId(empresaId) {
  const [[p]] = await pool.query(
    `SELECT id FROM perfis WHERE empresa_id = ? AND LOWER(nome) = 'administrador' LIMIT 1`,
    [empresaId]
  );
  return p?.id || null;
}

export async function countAdminsInCompany(empresaId) {
  const [[row]] = await pool.query(
    `
    SELECT COUNT(*) AS qtd
      FROM usuarios_perfis up
      JOIN perfis p ON p.id = up.perfil_id
     WHERE up.empresa_id = ?
       AND LOWER(p.nome) = 'administrador'
    `,
    [empresaId]
  );
  return Number(row?.qtd || 0);
}

/** Retorna true se o par (empresa_id, usuario_id) tem perfil Administrador */
export async function isUserAdminInCompany(empresaId, usuarioId) {
  const [[row]] = await pool.query(
    `
    SELECT 1 AS ok
      FROM usuarios_perfis up
      JOIN perfis p ON p.id = up.perfil_id
     WHERE up.empresa_id = ? AND up.usuario_id = ?
       AND LOWER(p.nome) = 'administrador'
     LIMIT 1
    `,
    [empresaId, usuarioId]
  );
  return !!row;
}

/** Idempotente: cria perfil Admin em todas as empresas que não têm */
export async function backfillAdminProfiles() {
  const [empresas] = await pool.query(`SELECT id FROM empresas`);
  for (const e of empresas) {
    await ensureAdminProfile(e.id);
  }
}
