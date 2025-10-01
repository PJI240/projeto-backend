// src/routes/permissoes.js
import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken";

const router = Router();

/* =========================================================
   Registro canônico (mantido)
   ========================================================= */
const PERMISSIONS_REGISTRY = [
  { codigo: "menu.dashboard.ver",     descricao: "Ver Dashboard",        escopo: "ui" },
  { codigo: "menu.usuarios.ver",      descricao: "Ver Usuários",         escopo: "ui" },
  { codigo: "menu.pessoas.ver",       descricao: "Ver Pessoas",          escopo: "ui" },
  { codigo: "menu.empresas.ver",      descricao: "Ver Empresas",         escopo: "ui" },
  { codigo: "menu.perfis.ver",        descricao: "Ver Perfis",           escopo: "ui" },
  { codigo: "menu.permissoes.ver",    descricao: "Ver Permissões",       escopo: "ui" },
  { codigo: "menu.cargos.ver",        descricao: "Ver Cargos",           escopo: "ui" },
  { codigo: "menu.funcionarios.ver",  descricao: "Ver Funcionários",     escopo: "ui" },

  { codigo: "usuarios.criar",         descricao: "Criar usuário",        escopo: "api" },
  { codigo: "usuarios.editar",        descricao: "Editar usuário",       escopo: "api" },
  { codigo: "usuarios.excluir",       descricao: "Excluir usuário",      escopo: "api" },

  { codigo: "pessoas.criar",          descricao: "Criar pessoa",         escopo: "api" },
  { codigo: "pessoas.editar",         descricao: "Editar pessoa",        escopo: "api" },
  { codigo: "pessoas.excluir",        descricao: "Excluir pessoa",       escopo: "api" },
];

/* =========================================================
   Auth básico (AGORA aceita Cookie OU Authorization: Bearer)
   ========================================================= */
function requireAuth(req, res, next) {
  try {
    // 1) Cookie "token"
    let token = req.cookies?.token;

    // 2) Fallback: Authorization: Bearer <JWT>
    if (!token) {
      const h = String(req.headers.authorization || "");
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (m) token = m[1];
    }

    if (!token) {
      return res.status(401).json({ ok: false, error: "Não autenticado." });
    }

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

/* =========================================================
   Helpers empresa/escopo
   ========================================================= */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
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

/* =========================================================
   Migração leve (mantida) — add colunas e UNIQUE(codigo)
   ========================================================= */
async function ensurePermissoesShape() {
  const [cols] = await pool.query(`SHOW COLUMNS FROM permissoes`);
  const names = new Set(cols.map((c) => c.Field));

  const alterParts = [];
  if (!names.has("descricao")) alterParts.push(`ADD COLUMN descricao VARCHAR(255) NULL`);
  if (!names.has("escopo")) alterParts.push(`ADD COLUMN escopo VARCHAR(50) NULL`);
  if (alterParts.length) {
    await pool.query(`ALTER TABLE permissoes ${alterParts.join(", ")}`);
  }

  const [idx] = await pool.query(`SHOW INDEX FROM permissoes`);
  const hasUniqueCodigo = idx.some((r) => r.Column_name === "codigo" && r.Non_unique === 0);
  if (!hasUniqueCodigo) {
    await pool.query(`ALTER TABLE permissoes ADD UNIQUE KEY uq_permissoes_codigo (codigo)`);
  }
}

/* =========================================================
   GET /api/permissoes — lista todas (mantido)
   ========================================================= */
router.get("/", requireAuth, async (_req, res) => {
  try {
    await ensurePermissoesShape();
    const [rows] = await pool.query(
      `SELECT id, codigo, descricao, escopo
         FROM permissoes
        ORDER BY codigo ASC`
    );
    return res.json({ ok: true, permissoes: rows });
  } catch (e) {
    console.error("PERMISSOES_LIST_ERR", e);
    return res.status(500).json({ ok: false, error: "Falha ao listar permissões." });
  }
});

/* =========================================================
   GET /api/permissoes/minhas
   - empresa_id (opcional) → valida vínculo
   - principal=1 → usa apenas perfil_principal (empresas_usuarios)
   - perfil_id=ID → força pegar as permissões deste perfil
   - caso nenhum filtro: união de TODOS perfis do usuário na empresa
   ========================================================= */
router.get("/minhas", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const principalOnly = String(req.query.principal || "") === "1";
    const perfilIdFilter = Number(req.query.perfil_id || 0) || null;

    // 1) Permissões de um perfil específico
    if (perfilIdFilter) {
      const [rows] = await pool.query(
        `SELECT DISTINCT pm.codigo
           FROM perfis_permissoes pp
           JOIN permissoes pm ON pm.id = pp.permissao_id
          WHERE pp.empresa_id = ? AND pp.perfil_id = ?`,
        [empresaId, perfilIdFilter]
      );
      return res.json({
        ok: true,
        scope: "perfil_id",
        perfil_id: perfilIdFilter,
        codes: rows.map((r) => r.codigo),
      });
    }

    // 2) Somente perfil_principal do usuário (texto → id de perfil)
    if (principalOnly) {
      const [[eu]] = await pool.query(
        `SELECT perfil_principal
           FROM empresas_usuarios
          WHERE usuario_id = ? AND empresa_id = ? AND ativo = 1
          LIMIT 1`,
        [req.userId, empresaId]
      );
      if (!eu?.perfil_principal) {
        return res.json({ ok: true, scope: "principal", codes: [] });
      }

      const [[perf]] = await pool.query(
        `SELECT id
           FROM perfis
          WHERE empresa_id = ?
            AND LOWER(nome) = LOWER(?)
          LIMIT 1`,
        [empresaId, eu.perfil_principal]
      );
      if (!perf?.id) {
        return res.json({ ok: true, scope: "principal", codes: [] });
      }

      const [rows] = await pool.query(
        `SELECT DISTINCT pm.codigo
           FROM perfis_permissoes pp
           JOIN permissoes pm ON pm.id = pp.permissao_id
          WHERE pp.empresa_id = ? AND pp.perfil_id = ?`,
        [empresaId, perf.id]
      );
      return res.json({
        ok: true,
        scope: "principal",
        perfil_id: perf.id,
        codes: rows.map((r) => r.codigo),
      });
    }

    // 3) União de TODOS os perfis do usuário na empresa
    const [rows] = await pool.query(
      `SELECT DISTINCT pm.codigo
         FROM usuarios_perfis up
         JOIN perfis_permissoes pp
           ON pp.perfil_id = up.perfil_id
          AND pp.empresa_id = up.empresa_id
         JOIN permissoes pm
           ON pm.id = pp.permissao_id
        WHERE up.usuario_id = ? AND up.empresa_id = ?`,
      [req.userId, empresaId]
    );

    return res.json({
      ok: true,
      scope: "all_profiles",
      codes: rows.map((r) => r.codigo),
    });
  } catch (e) {
    console.error("PERMISSOES_MINHAS_ERR", e);
    return res.status(400).json({ ok: false, error: "Falha ao obter permissões." });
  }
});

/* =========================================================
   POST /api/permissoes/sync — upsert canônico (mantido)
   ========================================================= */
router.post("/sync", requireAuth, async (_req, res) => {
  let conn;
  try {
    await ensurePermissoesShape();

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let upserted = 0;
    for (const { codigo, descricao, escopo } of PERMISSIONS_REGISTRY) {
      const [r] = await conn.query(
        `INSERT INTO permissoes (codigo, descricao, escopo)
              VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE
              descricao = VALUES(descricao),
              escopo    = VALUES(escopo)`,
        [codigo, descricao ?? null, escopo ?? null]
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
