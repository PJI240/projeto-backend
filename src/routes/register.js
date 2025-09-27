// routes/register.js
import express from "express";
import bcrypt from "bcrypt";
import pool from "../db.js";

const router = express.Router();

const onlyDigits = (s = "") => s.replace(/\D+/g, "");

function isValidCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
  // dígitos verificadores
  const calc = (slice) => {
    let pos = slice.length - 7, sum = 0;
    for (let i = slice.length; i >= 1; i--) {
      sum += Number(slice[slice.length - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const n = d.substring(0, 12);
  const dv1 = calc(n);
  const dv2 = calc(n + dv1);
  return d === (n + String(dv1) + String(dv2));
}

async function getOrCreateEmpresaByCNPJ(conn, empresaInput) {
  const cnpjNum = onlyDigits(empresaInput.cnpj);
  if (!isValidCNPJ(cnpjNum)) throw new Error("CNPJ inválido.");
  if (cnpjNum === "00000000000000") throw new Error("CNPJ reservado (GLOBAL).");


  const [rows] = await conn.query(
    "SELECT id FROM empresas WHERE REPLACE(REPLACE(REPLACE(cnpj,'/',''),'.',''),'-','') = ? LIMIT 1",
    [cnpjNum]
  );
  if (rows.length) return rows[0].id;

  // cria
  const {
    razao_social = "",
    nome_fantasia = "",
    inscricao_estadual = null,
    data_abertura = null,       // YYYY-MM-DD
    telefone = null,
    email = null,
    capital_social = null,      // DECIMAL
    natureza_juridica = null,
    situacao_cadastral = null,
    data_situacao = null,       // YYYY-MM-DD
    socios_receita = "[]",      // JSON string
  } = empresaInput;

  const [ins] = await conn.query(
    `INSERT INTO empresas
     (razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura, telefone, email,
      capital_social, natureza_juridica, situacao_cadastral, data_situacao, socios_receita, ativa)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      razao_social, nome_fantasia, cnpjNum, inscricao_estadual, data_abertura,
      telefone, email, capital_social, natureza_juridica, situacao_cadastral,
      data_situacao, socios_receita
    ]
  );
  return ins.insertId;
}

async function createPessoa(conn, empresaId, pessoaInput) {
  const {
    nome, cpf = "", data_nascimento = null, telefone = null, email = null,
  } = pessoaInput;

  if (!nome?.trim()) throw new Error("Nome da pessoa é obrigatório.");
  const cpfNum = onlyDigits(cpf);
  if (cpfNum && cpfNum.length !== 11) throw new Error("CPF inválido.");

  const [ins] = await conn.query(
    `INSERT INTO pessoas (nome, cpf, data_nascimento, telefone, email)
     VALUES (?,?,?,?,?)`,
    [nome, cpfNum || null, data_nascimento || null, telefone, email]
  );
  return ins.insertId;
}

async function createUsuario(conn, usuarioInput, pessoaNome) {
  const { nome = pessoaNome, email, senha, ativo = 1 } = usuarioInput;
  if (!email?.trim() || !senha?.trim()) throw new Error("E-mail e senha são obrigatórios.");
  const hash = await bcrypt.hash(senha, 10);

  const [ins] = await conn.query(
    `INSERT INTO usuarios (nome, email, senha, ativo) VALUES (?,?,?,?)`,
    [nome, email, hash, ativo ? 1 : 0]
  );
  return ins.insertId;
}

async function getOrCreatePerfilAdministrador(conn, empresaId) {
  // garante perfil 'administrador' nessa empresa
  const [p] = await conn.query(
    "SELECT id FROM perfis WHERE empresa_id = ? AND nome = 'administrador' LIMIT 1",
    [empresaId]
  );
  let perfilId = p[0]?.id;
  if (!perfilId) {
    const [ins] = await conn.query(
      "INSERT INTO perfis (empresa_id, nome, ativo) VALUES (?,?,1)",
      [empresaId, "administrador"]
    );
    perfilId = ins.insertId;
  }
  return perfilId;
}

async function linkUsuarioPerfil(conn, empresaId, usuarioId, perfilId) {
  await conn.query(
    `INSERT IGNORE INTO usuarios_perfis (empresa_id, usuario_id, perfil_id)
     VALUES (?,?,?)`,
    [empresaId, usuarioId, perfilId]
  );
  // opcional: vincular também em empresas_usuarios
  await conn.query(
    `INSERT IGNORE INTO empresas_usuarios (empresa_id, usuario_id, perfil_principal, ativo)
     VALUES (?,?,?,1)`,
    [empresaId, usuarioId, "administrador"]
  );
}

// ===== Rotas =====

/**
 * POST /api/registro/completo
 * Cria empresa (se não existir), pessoa, usuário (ativo=1),
 * garante perfil 'administrador' e vincula usuário ao perfil/empresa.
 * Body: { empresa:{...}, pessoa:{...}, usuario:{...} }
 */
router.post("/completo", async (req, res) => {
  const { empresa = {}, pessoa = {}, usuario = {} } = req.body || {};
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const empresaId = await getOrCreateEmpresaByCNPJ(conn, empresa);
    const pessoaId  = await createPessoa(conn, empresaId, pessoa);
    const usuarioId = await createUsuario(conn, usuario, pessoa.nome);
    const perfilId  = await getOrCreatePerfilAdministrador(conn, empresaId);

    await linkUsuarioPerfil(conn, empresaId, usuarioId, perfilId);

    await conn.commit();
    return res.json({
      ok: true,
      empresa_id: empresaId,
      pessoa_id: pessoaId,
      usuario_id: usuarioId,
      perfil_id: perfilId,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("REGISTER_COMPLETO_ERR", e);
    const msg = String(e?.message || "");
    const friendly = /reservado|inválido|Duplicate entry/i.test(msg)
      ? msg
      : "Não foi possível concluir o cadastro.";
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /api/registro/vincular-admin
 * Usuário já autenticado (usa req.session.uid).
 * Garante empresa (por CNPJ), garante perfil 'administrador' e vincula ao usuário atual.
 * Body: { empresa:{...} }
 */
router.post("/vincular-admin", async (req, res) => {
  const uid = req.session?.uid;
  if (!uid) return res.status(401).json({ ok: false, error: "Não autenticado." });

  const { empresa = {} } = req.body || {};
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const empresaId = await getOrCreateEmpresaByCNPJ(conn, empresa);
    const perfilId  = await getOrCreatePerfilAdministrador(conn, empresaId);

    await linkUsuarioPerfil(conn, empresaId, uid, perfilId);

    await conn.commit();
    return res.json({ ok: true, empresa_id: empresaId, perfil_id: perfilId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("REGISTER_VINCULAR_ERR", e);
    const msg = String(e?.message || "");
    const friendly = /reservado|inválido|Duplicate entry/i.test(msg)
      ? msg
      : "Não foi possível vincular a empresa ao usuário.";
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
