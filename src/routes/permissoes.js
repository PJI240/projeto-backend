import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken";

const router = Router();

/* ======= Registro canônico ======= */
const PERMISSIONS_REGISTRY = [
  // UI (menu.*)
  { codigo: "menu.apontamentos.ver",       descricao: "Ver Apontamentos",              escopo: "ui" },
  { codigo: "menu.cargos.ver",             descricao: "Ver Cargos",                   escopo: "ui" },
  { codigo: "menu.dashboard.ver",          descricao: "Ver Dashboard",                escopo: "ui" },
  { codigo: "menu.dashboard_adm.ver",      descricao: "Ver Dashboard Admin",          escopo: "ui" },
  { codigo: "menu.dashboard_func.ver",     descricao: "Ver Dashboard Funcionário",    escopo: "ui" },
  { codigo: "menu.empresas.ver",           descricao: "Ver Empresas",                 escopo: "ui" },
  { codigo: "menu.escalas.ver",            descricao: "Ver Escalas",                  escopo: "ui" },
  { codigo: "menu.folhas.ver",             descricao: "Ver Folhas",                   escopo: "ui" },
  { codigo: "menu.folhas-funcionarios.ver",descricao: "Ver Folhas × Funcionários",    escopo: "ui" },
  { codigo: "menu.folhas-itens.ver",       descricao: "Ver Itens de Folha",           escopo: "ui" },
  { codigo: "menu.funcionarios.ver",       descricao: "Ver Funcionários",             escopo: "ui" },
  { codigo: "menu.ocorrencias.ver",        descricao: "Ver Ocorrências",              escopo: "ui" },
  { codigo: "menu.perfis.ver",             descricao: "Ver Perfis",                   escopo: "ui" },
  { codigo: "menu.perfis-permissoes.ver",  descricao: "Ver Perfis × Permissões",      escopo: "ui" },
  { codigo: "menu.permissoes.ver",         descricao: "Ver Permissões",               escopo: "ui" },
  { codigo: "menu.pessoas.ver",            descricao: "Ver Pessoas",                  escopo: "ui" },
  { codigo: "menu.usuarios.ver",           descricao: "Ver Usuários",                 escopo: "ui" },

  // API
  { codigo: "pessoas.criar",               descricao: "Criar pessoa",                 escopo: "api" },
  { codigo: "pessoas.editar",              descricao: "Editar pessoa",                escopo: "api" },
  { codigo: "pessoas.excluir",             descricao: "Excluir pessoa",               escopo: "api" },
  { codigo: "usuarios.criar",              descricao: "Criar usuário",                escopo: "api" },
  { codigo: "usuarios.editar",             descricao: "Editar usuário",               escopo: "api" },
  { codigo: "usuarios.excluir",            descricao: "Excluir usuário",              escopo: "api" },
];

/* ======= Auth básico ======= */
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

/* ======= Migração automática da tabela =======
   - Adiciona colunas 'descricao' e 'escopo' se não existirem
   - Garante UNIQUE(codigo)
*/
async function ensurePermissoesShape() {
  // Descobre colunas atuais
  const [cols] = await pool.query(`SHOW COLUMNS FROM permissoes`);
  const names = new Set(cols.map(c => c.Field));

  const alterParts = [];

  if (!names.has("descricao")) {
    alterParts.push(`ADD COLUMN descricao VARCHAR(255) NULL`);
  }
  if (!names.has("escopo")) {
    // depois de descricao se possível (não é obrigatório)
    alterParts.push(`ADD COLUMN escopo VARCHAR(50) NULL`);
  }

  if (alterParts.length) {
    await pool.query(`ALTER TABLE permissoes ${alterParts.join(", ")}`);
  }

  // Garante UNIQUE em codigo
  const [idx] = await pool.query(`SHOW INDEX FROM permissoes`);
  const hasUniqueCodigo = idx.some(r => r.Column_name === "codigo" && r.Non_unique === 0);
  if (!hasUniqueCodigo) {
    // remove índice duplicado se houver e cria unique
    // (MySQL permite múltiplos índices no mesmo campo; aqui só garantimos o UNIQUE)
    await pool.query(`ALTER TABLE permissoes ADD UNIQUE KEY uq_permissoes_codigo (codigo)`);
  }
}

/* ======= GET /api/permissoes ======= */
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

/* ======= POST /api/permissoes/sync =======
   Upsert com base no registro canônico.
*/
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
