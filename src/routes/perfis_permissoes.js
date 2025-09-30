// src/routes/perfis_permissoes.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* =================== helpers =================== */

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

/** Resolve empresa corrente a partir do usuário e (opcional) ?empresa_id= */
async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");
  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada para o usuário.");
  }
  return empresas[0]; // default: 1ª empresa do usuário
}

function normRole(s = "") {
  return String(s || "").trim().toLowerCase();
}

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil_nome
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => normRole(r.perfil_nome));
}

function canManagePerms(roles = []) {
  const r = roles.map(normRole);
  return r.includes("desenvolvedor") || r.includes("administrador");
}

/* =================== GET /api/perfis-permissoes ===================
 * Query: perfil_id (obrigatório)
 * Retorna: { ok:true, ids:[permissao_id,...] }
 * Obs: valida se o perfil pertence à empresa corrente do usuário.
 * ================================================================ */
router.get("/", requireAuth, async (req, res) => {
  try {
    const perfilId = Number(req.query.perfil_id);
    if (!perfilId) return res.status(400).json({ ok: false, error: "perfil_id é obrigatório." });

    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    // Perfil precisa pertencer à empresa atual
    const [[pOk]] = await pool.query(
      `SELECT id FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [perfilId, empresaId]
    );
    if (!pOk) return res.status(404).json({ ok: false, error: "Perfil não encontrado nesta empresa." });

    const [rows] = await pool.query(
      `SELECT permissao_id AS id
         FROM perfis_permissoes
        WHERE empresa_id = ? AND perfil_id = ?
        ORDER BY permissao_id ASC`,
      [empresaId, perfilId]
    );

    return res.json({ ok: true, ids: rows.map((r) => Number(r.id)) });
  } catch (e) {
    console.error("PERFIS_PERMISSOES_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar permissões do perfil." });
  }
});

/* =================== POST /api/perfis-permissoes/sync ===================
 * Body: { perfil_id:number, ids:number[] }
 * Sincroniza (substitui) o conjunto de permissões do perfil na empresa atual.
 * Regras:
 *  - usuário deve ter papel desenvolvedor ou administrador
 *  - perfil precisa pertencer à empresa atual
 *  - ids devem existir em `permissoes`
 * ====================================================================== */
router.post("/sync", requireAuth, async (req, res) => {
  let conn;
  try {
    const { perfil_id, ids } = req.body || {};
    const perfilId = Number(perfil_id);
    if (!perfilId || !Array.isArray(ids)) {
      return res.status(400).json({ ok: false, error: "Dados inválidos. Informe perfil_id e ids." });
    }

    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const roles = await getUserRoles(req.userId);
    if (!canManagePerms(roles)) {
      return res.status(403).json({ ok: false, error: "Sem permissão para gerenciar perfis." });
    }

    // Perfil precisa pertencer à empresa atual
    const [[pOk]] = await pool.query(
      `SELECT id FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [perfilId, empresaId]
    );
    if (!pOk) return res.status(404).json({ ok: false, error: "Perfil não encontrado nesta empresa." });

    // Valida se todos os ids existem na tabela permissoes
    const uniqueIds = Array.from(new Set(ids.map((n) => Number(n)).filter(Number.isFinite)));
    if (uniqueIds.length) {
      const [val] = await pool.query(
        `SELECT id FROM permissoes WHERE id IN (${uniqueIds.map(() => "?").join(",")})`,
        uniqueIds
      );
      const found = new Set(val.map((r) => Number(r.id)));
      const invalid = uniqueIds.filter((i) => !found.has(i));
      if (invalid.length) {
        return res.status(400).json({ ok: false, error: `IDs de permissões inválidos: ${invalid.join(", ")}` });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Apaga tudo e regrava o conjunto (sync)
    await conn.query(
      `DELETE FROM perfis_permissoes WHERE empresa_id = ? AND perfil_id = ?`,
      [empresaId, perfilId]
    );

    if (uniqueIds.length) {
      const values = uniqueIds.map((pid) => [empresaId, perfilId, pid]);
      await conn.query(
        `INSERT INTO perfis_permissoes (empresa_id, perfil_id, permissao_id)
         VALUES ?`,
        [values]
      );
    }

    await conn.commit();
    return res.json({ ok: true, count: uniqueIds.length });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("PERFIS_PERMISSOES_SYNC_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao salvar permissões." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
