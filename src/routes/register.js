// routes/register.js
import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken"; // mantido, caso use depois
import bcrypt from "bcrypt";

const router = Router();

/* ===================== Helpers genéricos ===================== */
const onlyDigits = (s = "") => s.replace(/\D+/g, "");

function isValidCNPJ(cnpj) {
  const d = onlyDigits(cnpj);
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;
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

/** Converte string de data para 'YYYY-MM-DD' ou NULL.
 *  Aceita 'YYYY-MM-DD', 'DD/MM/YYYY' e valores vazios (→ NULL).
 */
function toDateOrNull(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // já está ok
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [dd, mm, yyyy] = s.split("/");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null; // qualquer coisa inesperada a gente zera para não quebrar
}

/** Converte valores (ex. "8.000,00") para número decimal ou NULL */
function toDecimalOrNull(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).replace(/[^\d,.-]/g, "").replace(",", ".");
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/** Garante JSON válido em string (para coluna JSON do MySQL) */
function toJsonString(value) {
  if (value === null || value === undefined) return "[]";
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return "[]";
    if (s.startsWith("[") || s.startsWith("{")) {
      // já parece JSON – tenta validar
      try { JSON.parse(s); return s; } catch { return "[]"; }
    }
    // se for string comum, tenta parsear; se não, vira []
    try { const parsed = JSON.parse(s); return JSON.stringify(parsed ?? []); }
    catch { return "[]"; }
  }
  try { return JSON.stringify(value ?? []); } catch { return "[]"; }
}

/* ===================== Helpers de registro ===================== */
async function getOrCreateEmpresaByCNPJ(conn, empresaInput) {
  const cnpjNum = onlyDigits(empresaInput.cnpj);
  if (!isValidCNPJ(cnpjNum)) throw new Error("CNPJ inválido.");
  if (cnpjNum === "00000000000000") throw new Error("CNPJ reservado (GLOBAL).");

  // tenta achar já existente
  const [rows] = await conn.query(
    "SELECT id FROM empresas WHERE REPLACE(REPLACE(REPLACE(cnpj,'/',''),'.',''),'-','') = ? LIMIT 1",
    [cnpjNum]
  );
  if (rows.length) return rows[0].id;

  // normaliza campos para INSERT seguro em modo estrito do MySQL
  const razao_social       = (empresaInput.razao_social || "").trim();
  const nome_fantasia      = (empresaInput.nome_fantasia || "").trim();
  const cnpj               = cnpjNum;
  const inscricao_estadual = (empresaInput.inscricao_estadual || "").trim() || null;
  const data_abertura      = toDateOrNull(empresaInput.data_abertura);
  const telefone           = (empresaInput.telefone || "").trim() || null;
  const email              = (empresaInput.email || "").trim() || null;
  const capital_social     = toDecimalOrNull(empresaInput.capital_social);
  const natureza_juridica  = (empresaInput.natureza_juridica || "").trim() || null;
  const situacao_cadastral = (empresaInput.situacao_cadastral || empresaInput.situicao || "").trim() || null;
  const data_situacao      = toDateOrNull(empresaInput.data_situicao);
  const socios_receita     = toJsonString(empresaInput.socios_receita);

  const [ins] = await conn.query(
    `INSERT INTO empresas
      (razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura,
       telefone, email, capital_social, natureza_juridica, situacao_cadastral,
       data_situacao, socios_receita, ativa)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura,
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
    [
      nome,
      cpfNum || null,
      toDateOrNull(data_nascimento), // normaliza data de nascimento
      (telefone || "").trim() || null,
      (email || "").trim() || null
    ]
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
  await conn.query(
    `INSERT IGNORE INTO empresas_usuarios (empresa_id, usuario_id, perfil_principal, ativo)
     VALUES (?,?,?,1)`,
    [empresaId, usuarioId, "administrador"]
  );
}

/* ===================== Rotas ===================== */

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
    const friendly = /reservado|inválido|Duplicate entry|CNPJ inválido/i.test(msg)
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
    const friendly = /reservado|inválido|Duplicate entry|CNPJ inválido/i.test(msg)
      ? msg
      : "Não foi possível vincular a empresa ao usuário.";
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
