// src/routes/permissoes_menu.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===== Registro canônico: APENAS itens de menu (escopo UI) ===== */
const MENU_PERMISSIONS = [
  { codigo: "menu.dashboard.ver",     descricao: "Ver Dashboard",        escopo: "ui" },
  { codigo: "menu.dashboard_func.ver",descricao: "Ver Meu Painel",       escopo: "ui" },
  { codigo: "menu.dashboard_adm.ver", descricao: "Ver Painel do Admin",  escopo: "ui" },
  { codigo: "menu.empresas.ver",      descricao: "Ver Empresas",         escopo: "ui" },
  { codigo: "menu.pessoas.ver",       descricao: "Ver Pessoas",          escopo: "ui" },
  { codigo: "menu.usuarios.ver",      descricao: "Ver Usuários",         escopo: "ui" },
  { codigo: "menu.perfis.ver",        descricao: "Ver Perfis",           escopo: "ui" },
  { codigo: "menu.permissoes.ver",    descricao: "Ver Permissões",       escopo: "ui" },
  { codigo: "menu.cargos.ver",        descricao: "Ver Cargos",           escopo: "ui" },
  { codigo: "menu.funcionarios.ver",  descricao: "Ver Funcionários",     escopo: "ui" },
  { codigo: "menu.escalas.ver",       descricao: "Ver Escalas",          escopo: "ui" },
  { codigo: "menu.apontamentos.ver",  descricao: "Ver Apontamentos",     escopo: "ui" },
  { codigo: "menu.ocorrencias.ver",   descricao: "Ver Ocorrências",      escopo: "ui" },
  { codigo: "menu.folhas.ver",        descricao: "Ver Folhas",           escopo: "ui" },
  { codigo: "menu.folhas_funcionarios.ver", descricao: "Ver Folhas × Funcionários", escopo: "ui" },
  { codigo: "menu.folhas_itens.ver",  descricao: "Ver Itens de Folha",   escopo: "ui" },
  { codigo: "menu.dev.ver",           descricao: "Ver seção Dev",        escopo: "ui" },
];

/* ===== Auth (cookie ou Authorization: Bearer) só para esta rota ===== */
function requireAuth(req, res, next) {
  try {
    let token = req.cookies?.token;
    if (!token) {
      const h = String(req.headers.authorization || "");
      const m = h.match(/^Bearer\s+(.+)$/i);
      if (m) token = m[1];
    }
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

/* ===== Helpers empresa ===== */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id FROM empresas_usuarios WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map(r => r.empresa_id);
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

/* ===== Hardening da tabela permissoes (sem conflitar com o outro arquivo) ===== */
async function ensurePermissoesShape() {
  const [cols] = await pool.query(`SHOW COLUMNS FROM permissoes`);
  const names = new Set(cols.map(c => c.Field));
  const alters = [];
  if (!names.has("descricao")) alters.push(`ADD COLUMN descricao VARCHAR(255) NULL`);
  if (!names.has("escopo")) alters.push(`ADD COLUMN escopo VARCHAR(50) NULL`);
  if (alters.length) await pool.query(`ALTER TABLE permissoes ${alters.join(", ")}`);

  const [idx] = await pool.query(`SHOW INDEX FROM permissoes`);
  const hasUnique = idx.some(r => r.Column_name === "codigo" && r.Non_unique === 0);
  if (!hasUnique) await pool.query(`ALTER TABLE permissoes ADD UNIQUE KEY uq_permissoes_codigo (codigo)`);
}

/* ===== POST /api/permissoes_menu/sync  (opcional, roda no deploy) =====
   - Faz upsert só dos códigos de MENU (escopo ui)
*/
router.post("/sync", requireAuth, async (_req, res) => {
  let conn;
  try {
    await ensurePermissoesShape();
    conn = await pool.getConnection();
    await conn.beginTransaction();

    let upserted = 0;
    for (const { codigo, descricao, escopo } of MENU_PERMISSIONS) {
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
    console.error("PERMISSOES_MENU_SYNC_ERR", e);
    return res.status(500).json({ ok: false, error: "Falha ao sincronizar permissões de menu." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===== GET /api/permissoes_menu/minhas
   - Retorna SOMENTE códigos de menu (escopo ui, prefixo "menu.")
   - Query:
       empresa_id (opcional)
       principal=1  → usa só o perfil_principal do usuário nessa empresa
*/
router.get("/minhas", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const principalOnly = String(req.query.principal || "") === "1";

    // Dev/Admin têm menu completo (opcional: deixe por regra de perfil)
    // Aqui manteremos regra 100% por perfis/permissões.

    if (principalOnly) {
      // pega perfil_principal textual → mapeia para perfis.id da empresa
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
          WHERE pp.empresa_id = ?
            AND pp.perfil_id  = ?
            AND pm.escopo = 'ui'
            AND pm.codigo LIKE 'menu.%'`,
        [empresaId, perf.id]
      );
      return res.json({
        ok: true,
        scope: "principal",
        perfil_id: perf.id,
        codes: rows.map(r => r.codigo),
      });
    }

    // União de todos os perfis do usuário na empresa (apenas "menu.%")
    const [rows] = await pool.query(
      `SELECT DISTINCT pm.codigo
         FROM usuarios_perfis up
         JOIN perfis_permissoes pp
           ON pp.perfil_id  = up.perfil_id
          AND pp.empresa_id = up.empresa_id
         JOIN permissoes pm
           ON pm.id = pp.permissao_id
        WHERE up.usuario_id = ?
          AND up.empresa_id = ?
          AND pm.escopo = 'ui'
          AND pm.codigo LIKE 'menu.%'`,
      [req.userId, empresaId]
    );
    return res.json({
      ok: true,
      scope: "all_profiles",
      codes: rows.map(r => r.codigo),
    });
  } catch (e) {
    console.error("PERMISSOES_MENU_MINHAS_ERR", e);
    return res.status(400).json({ ok: false, error: "Falha ao obter permissões de menu." });
  }
});

export default router;
