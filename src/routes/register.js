// routes/register.js
import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";

const router = Router();

/* ========= helpers ========= */
const onlyDigits = (s = "") => String(s).replace(/\D+/g, "");
const trimOrNull = (s) => {
  const v = (s ?? "").toString().trim();
  return v ? v : null;
};
const limit = (s, n) => (s == null ? null : String(s).slice(0, n));
const toYYYYMMDDorNull = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  // "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // "DD/MM/YYYY"
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
};
function normalizePhone(raw) {
  if (!raw) return null;
  // pega só o primeiro número (se vier "A / B, C")
  const first = String(raw).split(/[\/,;]+/)[0];
  const digits = onlyDigits(first).slice(0, 20);
  return digits || null;
}
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

/* ========= empresa ========= */
async function getOrCreateEmpresaByCNPJ(conn, empresaInput) {
  const cnpjNum = onlyDigits(empresaInput.cnpj);
  if (!isValidCNPJ(cnpjNum)) throw new Error("CNPJ inválido.");
  if (cnpjNum === "00000000000000") throw new Error("CNPJ reservado (GLOBAL).");

  // já existe?
  const [rows] = await conn.query(
    "SELECT id FROM empresas WHERE REPLACE(REPLACE(REPLACE(cnpj,'/',''),'.',''),'-','') = ? LIMIT 1",
    [cnpjNum]
  );
  if (rows.length) return rows[0].id;

  // normalizações e limites de tamanho conforme schema
  const razao_social       = limit(trimOrNull(empresaInput.razao_social), 255) || "";
  const nome_fantasia      = limit(trimOrNull(empresaInput.nome_fantasia), 255);
  const inscricao_estadual = limit(trimOrNull(empresaInput.inscricao_estadual), 50);
  const data_abertura      = toYYYYMMDDorNull(empresaInput.data_abertura);
  const telefone           = normalizePhone(empresaInput.telefone);
  const email              = limit(trimOrNull(empresaInput.email), 255);
  const capital_social     = Number.isFinite(+empresaInput.capital_social)
    ? +empresaInput.capital_social
    : null;
  const natureza_juridica  = limit(trimOrNull(empresaInput.natureza_juridica), 100);
  const situacao_cadastral = limit(trimOrNull(empresaInput.situacao_cadastral), 50);
  const data_situacao      = toYYYYMMDDorNull(empresaInput.data_situacao);

  // JSON: aceita objeto/array ou string JSON
  let socios_receita = "[]";
  if (Array.isArray(empresaInput.socios_receita) || typeof empresaInput.socios_receita === "object") {
    try { socios_receita = JSON.stringify(empresaInput.socios_receita); } catch {}
  } else if (typeof empresaInput.socios_receita === "string") {
    try { JSON.parse(empresaInput.socios_receita); socios_receita = empresaInput.socios_receita; } catch {}
  }

  const [ins] = await conn.query(
    `INSERT INTO empresas
      (razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura,
       telefone, email, capital_social, natureza_juridica, situacao_cadastral,
       data_situacao, socios_receita, ativa)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      razao_social,
      nome_fantasia,
      cnpjNum,
      inscricao_estadual,
      data_abertura,
      telefone, // <= sempre <= 20 ou null
      email,
      capital_social,
      natureza_juridica,
      situacao_cadastral,
      data_situacao,
      socios_receita
    ]
  );
  return ins.insertId;
}

/* ========= pessoa ========= */
async function createPessoa(conn, pessoaInput) {
  const {
    nome, cpf = "", data_nascimento = null, telefone = null, email = null,
  } = pessoaInput;

  if (!nome?.trim()) throw new Error("Nome da pessoa é obrigatório.");
  const cpfNum = onlyDigits(cpf);
  if (cpfNum && cpfNum.length !== 11) throw new Error("CPF inválido.");

  const [ins] = await conn.query(
    `INSERT INTO pessoas (nome, cpf, data_nascimento, telefone, email)
     VALUES (?,?,?,?,?)`,
    [limit(nome,150), cpfNum || null, toYYYYMMDDorNull(data_nascimento), limit(telefone,20), limit(email,150)]
  );
  return ins.insertId;
}

/* ========= usuário ========= */
async function createUsuario(conn, usuarioInput, pessoaNome) {
  const { nome = pessoaNome, email, senha, ativo = 1 } = usuarioInput;
  if (!email?.trim() || !senha?.trim()) throw new Error("E-mail e senha são obrigatórios.");
  const hash = await bcrypt.hash(senha, 10);

  const [ins] = await conn.query(
    `INSERT INTO usuarios (nome, email, senha, ativo) VALUES (?,?,?,?)`,
    [limit(nome,150), String(email).trim().toLowerCase(), hash, ativo ? 1 : 0]
  );
  return ins.insertId;
}

/* ========= perfil/vínculos ========= */
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

/* ========= NOVO: usuário × pessoa ========= */
async function linkUsuarioPessoa(conn, empresaId, usuarioId, pessoaId) {
  // Garante o vínculo 1–1 no escopo da empresa (chave única recomendada no banco)
  await conn.query(
    `INSERT IGNORE INTO usuarios_pessoas (empresa_id, usuario_id, pessoa_id)
     VALUES (?,?,?)`,
    [empresaId, usuarioId, pessoaId]
  );
}

/* ========= rotas ========= */

/**
 * POST /api/registro/completo
 * Body: { empresa:{...}, pessoa:{...}, usuario:{...} }
 * Cria empresa (se necessário), cria pessoa, cria usuário (ativo=1),
 * garante perfil 'administrador', vincula usuário→perfil/empresa
 * E AGORA: vincula usuário→pessoa em usuarios_pessoas.
 */
router.post("/completo", async (req, res) => {
  const { empresa = {}, pessoa = {}, usuario = {} } = req.body || {};
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const empresaId = await getOrCreateEmpresaByCNPJ(conn, empresa);
    const pessoaId  = await createPessoa(conn, pessoa);
    const usuarioId = await createUsuario(conn, usuario, pessoa.nome);
    const perfilId  = await getOrCreatePerfilAdministrador(conn, empresaId);

    await linkUsuarioPerfil(conn, empresaId, usuarioId, perfilId);
    await linkUsuarioPessoa(conn, empresaId, usuarioId, pessoaId); // <<< NOVO

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
    const friendly = /reservado|inválido|Duplicate entry|CNPJ|CPF/i.test(msg)
      ? msg
      : "Não foi possível concluir o cadastro.";
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /api/registro/vincular-admin
 * Body: { empresa:{...} }  (usuário já autenticado via cookie)
 * Obs.: aqui não criamos usuarios_pessoas porque é um fluxo
 * de “vincular nova empresa” para um usuário que pode já ter pessoa.
 */
router.post("/vincular-admin", async (req, res) => {
  const uid = req.userId || null; // se você usa middleware de auth, injete aqui
  try {
    // fallback simples usando JWT do cookie
    let userId = uid;
    if (!userId) {
      const { token } = req.cookies || {};
      if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
      const payload = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64").toString() || "{}");
      userId = payload.sub;
    }

    const { empresa = {} } = req.body || {};
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    const empresaId = await getOrCreateEmpresaByCNPJ(conn, empresa);
    const perfilId  = await getOrCreatePerfilAdministrador(conn, empresaId);

    await linkUsuarioPerfil(conn, empresaId, userId, perfilId);

    await conn.commit();
    conn.release();

    return res.json({ ok: true, empresa_id: empresaId, perfil_id: perfilId });
  } catch (e) {
    console.error("REGISTER_VINCULAR_ERR", e);
    const msg = String(e?.message || "");
    const friendly = /reservado|inválido|Duplicate entry|CNPJ|CPF/i.test(msg)
      ? msg
      : "Não foi possível vincular a empresa ao usuário.";
    return res.status(400).json({ ok: false, error: friendly });
  }
});

export default router;
