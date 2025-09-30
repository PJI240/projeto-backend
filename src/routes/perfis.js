// src/routes/perfis.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ================== helpers ================== */
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

const normalize = (s = "") => String(s).trim();
const isAdminName = (s = "") => normalize(s).toLowerCase() === "administrador";

/* ================== rotas ================== */

/**
 * GET /api/perfis?empresa_id=OPC
 * Lista perfis da empresa atual.
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

/**
 * POST /api/perfis
 * Body: { nome, ativo? }
 * Cria um novo perfil para a empresa do usuário (nome único na empresa).
 * Garante existência do 'administrador' mas não permite criá-lo duplicado.
 */
router.post("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    let { nome, ativo = 1 } = req.body || {};
    nome = normalize(nome);

    if (!nome) return res.status(400).json({ ok: false, error: "Nome é obrigatório." });

    // Unicidade por empresa
    const [[dup]] = await pool.query(
      `SELECT id FROM perfis WHERE empresa_id = ? AND LOWER(nome) = LOWER(?) LIMIT 1`,
      [empresaId, nome]
    );
    if (dup) return res.status(409).json({ ok: false, error: "Já existe um perfil com este nome na empresa." });

    // Insere
    const [ins] = await pool.query(
      `INSERT INTO perfis (empresa_id, nome, ativo) VALUES (?,?,?)`,
      [empresaId, nome, ativo ? 1 : 0]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("PERFIL_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar perfil." });
  }
});

/**
 * PUT /api/perfis/:id
 * Body: { nome?, ativo? }
 * Atualiza nome/ativo do perfil.
 * Regras:
 *  - não permitir renomear/remover o 'administrador'
 *  - manter unicidade por empresa
 */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    let { nome, ativo } = req.body || {};
    if (nome != null) nome = normalize(nome);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[pf]] = await conn.query(
      `SELECT id, nome, ativo FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!pf) throw new Error("Perfil não encontrado na empresa selecionada.");

    // bloqueia operações perigosas no 'administrador'
    if (isAdminName(pf.nome)) {
      // não permitir renomear nem desativar o administrador
      if ((nome && nome !== pf.nome) || (ativo === 0 || ativo === false)) {
        throw new Error("O perfil 'administrador' não pode ser renomeado nem desativado.");
      }
      // nada a atualizar? retorna ok
      await conn.commit();
      conn.release();
      return res.json({ ok: true });
    }

    // se vai renomear: valida unicidade
    if (nome && nome !== pf.nome) {
      const [[dup]] = await conn.query(
        `SELECT id FROM perfis WHERE empresa_id = ? AND LOWER(nome) = LOWER(?) AND id <> ? LIMIT 1`,
        [empresaId, nome, id]
      );
      if (dup) throw new Error("Já existe outro perfil com este nome.");
    }

    // Atualiza
    const newNome = nome != null ? nome : pf.nome;
    const newAtivo = ativo != null ? (ativo ? 1 : 0) : pf.ativo;

    await conn.query(
      `UPDATE perfis SET nome = ?, ativo = ? WHERE id = ? AND empresa_id = ?`,
      [newNome, newAtivo, id, empresaId]
    );

    await conn.commit();
    conn.release();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("PERFIL_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar perfil." });
  }
});

/**
 * DELETE /api/perfis/:id
 * Regras:
 *  - não pode remover 'administrador'
 *  - não pode remover se houver usuários vinculados ao perfil
 */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[pf]] = await conn.query(
      `SELECT id, nome FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!pf) throw new Error("Perfil não encontrado na empresa selecionada.");

    if (isAdminName(pf.nome)) {
      throw new Error("O perfil 'administrador' não pode ser removido.");
    }

    // verifica vínculos
    const [[use]] = await conn.query(
      `SELECT 1 FROM usuarios_perfis WHERE empresa_id = ? AND perfil_id = ? LIMIT 1`,
      [empresaId, id]
    );
    if (use) throw new Error("Não é possível remover: há usuários vinculados a este perfil.");

    await conn.query(`DELETE FROM perfis WHERE id = ? AND empresa_id = ?`, [id, empresaId]);

    await conn.commit();
    conn.release();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("PERFIL_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir perfil." });
  }
});

export default router;
