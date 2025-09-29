// src/routes/usuarios.js
import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ========== bootstrap: cria tabela de vínculo 1:1 se não existir ========== */
/**
 * usuarios_pessoas
 *  - empresa_id INT NOT NULL
 *  - usuario_id INT NOT NULL
 *  - pessoa_id  INT NOT NULL (UNIQUE → uma pessoa só pode ter um usuário)
 *  Constraints:
 *    - UNIQUE(pessoa_id)
 *    - UNIQUE(empresa_id, usuario_id) → evita duplicidade de vínculo por empresa
 */
async function ensureUsuariosPessoasTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios_pessoas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT NOT NULL,
      usuario_id INT NOT NULL,
      pessoa_id INT NOT NULL,
      UNIQUE KEY uq_pessoa (pessoa_id),
      UNIQUE KEY uq_empresa_usuario (empresa_id, usuario_id),
      CONSTRAINT fk_up_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE,
      CONSTRAINT fk_up_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
      CONSTRAINT fk_up_pessoa  FOREIGN KEY (pessoa_id)  REFERENCES pessoas(id)  ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}
ensureUsuariosPessoasTable().catch((e) => {
  console.error("BOOTSTRAP usuarios_pessoas ERR:", e);
});

/* ========== helpers compartilhados ========== */

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

function normalize(s = "") {
  return String(s || "").trim();
}

function normalizeRoleName(s = "") {
  return String(s).trim().toLowerCase();
}

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil_nome
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => normalizeRoleName(r.perfil_nome));
}

function canAssignAdmin(roles = []) {
  const r = roles.map(normalizeRoleName);
  return r.includes("desenvolvedor") || r.includes("administrador");
}

/* ========== GET /api/usuarios (lista por empresa) ========== */
/**
 * Retorna usuários vinculados à empresa corrente, com:
 *  - pessoa (via usuarios_pessoas)
 *  - perfil principal (via usuarios_perfis) — 1 por empresa/usuário
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const [rows] = await pool.query(
      `
      SELECT u.id, u.nome, u.email, u.ativo,
             up.pessoa_id,
             p.nome  AS pessoa_nome,
             p.cpf   AS pessoa_cpf,
             pf.id   AS perfil_id,
             pf.nome AS perfil_nome
        FROM empresas_usuarios eu
        JOIN usuarios u ON u.id = eu.usuario_id
   LEFT JOIN usuarios_pessoas up ON up.usuario_id = u.id AND up.empresa_id = eu.empresa_id
   LEFT JOIN pessoas p ON p.id = up.pessoa_id
   LEFT JOIN usuarios_perfis upf ON upf.usuario_id = u.id AND upf.empresa_id = eu.empresa_id
   LEFT JOIN perfis pf ON pf.id = upf.perfil_id
       WHERE eu.empresa_id = ?
       ORDER BY u.nome ASC
      `,
      [empresaId]
    );
    return res.json({ ok: true, empresa_id: empresaId, usuarios: rows });
  } catch (e) {
    console.error("USUARIOS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar usuários." });
  }
});

/* ========== POST /api/usuarios (criar + vincular) ========== */
/**
 * Body: {
 *   pessoa_id, nome, email, senha, perfil_id, ativo
 * }
 * Passos:
 *   1) valida perfil permitido (se admin) e unicidade email
 *   2) cria usuario
 *   3) vincula em empresas_usuarios (ativo=1)
 *   4) vincula pessoa 1:1 (usuarios_pessoas) — UNIQUE(pessoa_id)
 *   5) vincula perfil (usuarios_perfis)
 */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const myRoles = await getUserRoles(req.userId);

    let {
      pessoa_id,
      nome,
      email,
      senha,
      perfil_id,
      ativo = 1,
    } = req.body || {};

    pessoa_id = Number(pessoa_id);
    perfil_id = Number(perfil_id);
    nome = normalize(nome);
    email = normalize(email).toLowerCase();
    senha = String(senha || "");

    if (!pessoa_id) return res.status(400).json({ ok: false, error: "Pessoa é obrigatória." });
    if (!nome || !email || !senha) return res.status(400).json({ ok: false, error: "Nome, e-mail e senha são obrigatórios." });
    if (!perfil_id) return res.status(400).json({ ok: false, error: "Perfil é obrigatório." });

    // valida perfil pertence à empresa + regra de admin
    const [[perfil]] = await pool.query(
      `SELECT id, nome FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [perfil_id, empresaId]
    );
    if (!perfil) return res.status(400).json({ ok: false, error: "Perfil inválido para esta empresa." });
    if (normalizeRoleName(perfil.nome) === "administrador" && !canAssignAdmin(myRoles)) {
      return res.status(403).json({ ok: false, error: "Você não pode atribuir o perfil administrador." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) pessoa existe?
    const [[pOk]] = await conn.query(`SELECT id FROM pessoas WHERE id = ? LIMIT 1`, [pessoa_id]);
    if (!pOk) throw new Error("Pessoa inexistente.");

    // 2) pessoa já tem usuário? (1:1)
    const [[pLink]] = await conn.query(
      `SELECT id FROM usuarios_pessoas WHERE pessoa_id = ? LIMIT 1`,
      [pessoa_id]
    );
    if (pLink) throw new Error("Esta pessoa já está vinculada a um usuário.");

    // 3) email único
    const [[uExists]] = await conn.query(`SELECT id FROM usuarios WHERE LOWER(email) = ? LIMIT 1`, [email]);
    if (uExists) throw new Error("E-mail já cadastrado.");

    // 4) cria usuário
    const hash = await bcrypt.hash(senha, 12);
    const [insU] = await conn.query(
      `INSERT INTO usuarios (nome, email, senha, ativo) VALUES (?,?,?,?)`,
      [nome, email, hash, ativo ? 1 : 0]
    );
    const usuarioId = insU.insertId;

    // 5) vincula à empresa
    await conn.query(
      `INSERT INTO empresas_usuarios (empresa_id, usuario_id, perfil_principal, ativo)
       VALUES (?,?,?,1)`,
      [empresaId, usuarioId, normalize(perfil.nome)]
    );

    // 6) vínculo 1:1 pessoa↔usuario nesta empresa
    await conn.query(
      `INSERT INTO usuarios_pessoas (empresa_id, usuario_id, pessoa_id) VALUES (?,?,?)`,
      [empresaId, usuarioId, pessoa_id]
    );

    // 7) vincula perfil
    await conn.query(
      `INSERT INTO usuarios_perfis (empresa_id, usuario_id, perfil_id) VALUES (?,?,?)`,
      [empresaId, usuarioId, perfil_id]
    );

    await conn.commit();
    return res.json({ ok: true, id: usuarioId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("USUARIO_CREATE_ERR", e);
    const msg = String(e?.message || "");
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de dados: pessoa já vinculada ou e-mail já em uso." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar usuário." });
  } finally {
    if (conn) conn.release();
  }
});

// ========== PUT /api/usuarios/:id ==========
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const myRoles = await getUserRoles(req.userId);
    const id = Number(req.params.id);

    let { nome, email, senha, perfil_id, ativo = 1 } = req.body || {};
    nome = normalize(nome);
    email = normalize(email).toLowerCase();
    perfil_id = Number(perfil_id);
    senha = senha ? String(senha) : "";

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // garante vínculo
    const [[uOk]] = await conn.query(
      `SELECT u.id, u.email, u.nome
         FROM empresas_usuarios eu
         JOIN usuarios u ON u.id = eu.usuario_id
        WHERE eu.empresa_id = ? AND eu.usuario_id = ?
        LIMIT 1`,
      [empresaId, id]
    );
    if (!uOk) throw new Error("Usuário não pertence à empresa selecionada.");

    // e-mail único se mudou
    if (email && email !== String(uOk.email).toLowerCase()) {
      const [[dup]] = await conn.query(
        `SELECT id FROM usuarios WHERE LOWER(email) = ? AND id <> ? LIMIT 1`,
        [email, id]
      );
      if (dup) throw new Error("E-mail já utilizado por outro usuário.");
    }

    // perfil válido?
    if (!perfil_id) throw new Error("Perfil é obrigatório.");
    const [[perfil]] = await conn.query(
      `SELECT id, nome FROM perfis WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [perfil_id, empresaId]
    );
    if (!perfil) throw new Error("Perfil inválido para esta empresa.");
    const novoPerfilAdmin = isAdminName(perfil.nome);
    const podeAtribuirAdmin = myRoles.some(r => ["desenvolvedor","administrador"].includes(String(r).toLowerCase()));
    if (novoPerfilAdmin && !podeAtribuirAdmin) {
      throw new Error("Você não pode atribuir o perfil Administrador.");
    }

    // BLOQUEIO “último admin”: se usuário ATUALMENTE é admin e é o último, não pode trocar para não-admin ou desativar
    const ehAdminAtual = await isUserAdminInCompany(empresaId, id);
    if (ehAdminAtual) {
      const qtdAdmins = await countAdminsInCompany(empresaId);
      const viraraNaoAdmin = !novoPerfilAdmin || !ativo;
      if (qtdAdmins <= 1 && viraraNaoAdmin) {
        throw new Error("A empresa não pode ficar sem Administrador.");
      }
    }

    // atualiza usuario
    if (senha) {
      const hash = await bcrypt.hash(senha, 12);
      await conn.query(
        `UPDATE usuarios SET nome = ?, email = ?, senha = ?, ativo = ? WHERE id = ?`,
        [nome || uOk.nome, email || uOk.email, hash, ativo ? 1 : 0, id]
      );
    } else {
      await conn.query(
        `UPDATE usuarios SET nome = ?, email = ?, ativo = ? WHERE id = ?`,
        [nome || uOk.nome, email || uOk.email, ativo ? 1 : 0, id]
      );
    }

    // atualiza perfil principal
    await conn.query(
      `UPDATE empresas_usuarios SET perfil_principal = ? WHERE empresa_id = ? AND usuario_id = ?`,
      [normalize(perfil.nome), empresaId, id]
    );

    // reatribui perfil
    await conn.query(
      `DELETE FROM usuarios_perfis WHERE empresa_id = ? AND usuario_id = ?`,
      [empresaId, id]
    );
    await conn.query(
      `INSERT INTO usuarios_perfis (empresa_id, usuario_id, perfil_id) VALUES (?,?,?)`,
      [empresaId, id, perfil_id]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("USUARIO_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar usuário." });
  } finally {
    if (conn) conn.release();
  }
});

// ========== DELETE /api/usuarios/:id ==========
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // Se este usuário é admin e é o último, bloquear
    const ehAdmin = await isUserAdminInCompany(empresaId, id);
    if (ehAdmin) {
      const qtdAdmins = await countAdminsInCompany(empresaId);
      if (qtdAdmins <= 1) {
        return res.status(400).json({ ok: false, error: "Não é possível remover o último Administrador da empresa." });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[uOk]] = await conn.query(
      `SELECT 1 FROM empresas_usuarios WHERE empresa_id = ? AND usuario_id = ? LIMIT 1`,
      [empresaId, id]
    );
    if (!uOk) throw new Error("Usuário não pertence à empresa selecionada.");

    await conn.query(`DELETE FROM usuarios_perfis WHERE empresa_id = ? AND usuario_id = ?`, [empresaId, id]);
    await conn.query(`DELETE FROM usuarios_pessoas WHERE empresa_id = ? AND usuario_id = ?`, [empresaId, id]);
    await conn.query(`DELETE FROM empresas_usuarios WHERE empresa_id = ? AND usuario_id = ?`, [empresaId, id]);

    const [[still]] = await conn.query(`SELECT 1 FROM empresas_usuarios WHERE usuario_id = ? LIMIT 1`, [id]);
    if (!still) await conn.query(`DELETE FROM usuarios WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("USUARIO_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir usuário." });
  } finally {
    if (conn) conn.release();
  }
});
export default router;