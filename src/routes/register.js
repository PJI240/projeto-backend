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
const normalizePhone = (raw) => {
  if (!raw) return null;
  const first = String(raw).split(/[\/,;]+/)[0];
  const digits = onlyDigits(first).slice(0, 20);
  return digits || null;
};
const isValidCNPJ = (cnpj) => {
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
};
const isValidCPF = (cpf) => {
  const d = onlyDigits(cpf);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  
  const calc = (slice) => {
    let sum = 0;
    for (let i = 0; i < slice.length; i++) {
      sum += Number(slice[i]) * (slice.length + 1 - i);
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  
  const n = d.substring(0, 9);
  const dv1 = calc(n);
  const dv2 = calc(n + dv1);
  
  return d === (n + String(dv1) + String(dv2));
};

/* ========= consulta CNPJ na API ========= */
async function consultaCNPJnaAPI(cnpj) {
  try {
    const num = onlyDigits(cnpj);
    
    // Usando fetch nativo em vez de axios
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`https://www.receitaws.com.br/v1/cnpj/${num}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Erro na consulta: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (data.status !== "OK") {
      throw new Error("Falha na consulta ReceitaWS");
    }

    return {
      razao_social: data.nome,
      nome_fantasia: data.fantasia,
      cnpj: data.cnpj,
      inscricao_estadual: data.inscricao_estadual || null,
      data_abertura: data.abertura ? data.abertura.split("/").reverse().join("-") : null,
      telefone: data.telefone,
      email: data.email,
      capital_social: data.capital_social ? 
        parseFloat(data.capital_social.replace(/[^\d,.-]/g, "").replace(",", ".")) : null,
      natureza_juridica: data.natureza_juridica,
      situacao_cadastral: data.situacao,
      data_situacao: data.data_situacao ? data.data_situacao.split("/").reverse().join("-") : null,
      socios_receita: data.qsa || []
    };
  } catch (error) {
    console.error("ERRO_CONSULTA_CNPJ_API", error.message);
    
    if (error.name === 'AbortError') {
      throw new Error("Tempo limite excedido na consulta do CNPJ");
    }
    
    throw new Error("Erro ao consultar dados do CNPJ na Receita Federal");
  }
}

/* ========= empresa ========= */
async function createEmpresa(conn, empresaInput) {
  const cnpjNum = onlyDigits(empresaInput.cnpj);
  
  if (!isValidCNPJ(cnpjNum)) throw new Error("CNPJ inválido.");
  if (cnpjNum === "00000000000000") throw new Error("CNPJ reservado (GLOBAL).");

  // Verifica se CNPJ já existe
  const [rows] = await conn.query(
    "SELECT id FROM empresas WHERE cnpj = ? LIMIT 1",
    [cnpjNum]
  );
  
  if (rows.length > 0) {
    throw new Error("CNPJ já cadastrado no sistema");
  }

  const razao_social       = limit(trimOrNull(empresaInput.razao_social), 255) || "";
  const nome_fantasia      = limit(trimOrNull(empresaInput.nome_fantasia), 255);
  const inscricao_estadual = limit(trimOrNull(empresaInput.inscricao_estadual), 50);
  const data_abertura      = toYYYYMMDDorNull(empresaInput.data_abertura);
  const telefone           = normalizePhone(empresaInput.telefone);
  const email              = limit(trimOrNull(empresaInput.email), 255);
  const capital_social     = Number.isFinite(+empresaInput.capital_social) ? +empresaInput.capital_social : null;
  const natureza_juridica  = limit(trimOrNull(empresaInput.natureza_juridica), 100);
  const situacao_cadastral = limit(trimOrNull(empresaInput.situacao_cadastral), 50);
  const data_situacao      = toYYYYMMDDorNull(empresaInput.data_situacao);

  let socios_receita = "[]";
  if (Array.isArray(empresaInput.socios_receita) || typeof empresaInput.socios_receita === "object") {
    try { 
      socios_receita = JSON.stringify(empresaInput.socios_receita); 
    } catch (e) {
      console.error("Erro ao serializar sócios:", e);
    }
  } else if (typeof empresaInput.socios_receita === "string") {
    try { 
      JSON.parse(empresaInput.socios_receita); 
      socios_receita = empresaInput.socios_receita; 
    } catch (e) {}
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
      telefone,
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
    nome, 
    cpf = "", 
    data_nascimento = null, 
    telefone = null, 
    email = null,
  } = pessoaInput;

  if (!nome?.trim()) throw new Error("Nome da pessoa é obrigatório.");
  
  const cpfNum = onlyDigits(cpf);
  if (cpfNum && !isValidCPF(cpfNum)) throw new Error("CPF inválido.");

  // Verifica se CPF já existe (se foi informado)
  if (cpfNum) {
    const [pessoasExistentes] = await conn.query(
      "SELECT id FROM pessoas WHERE cpf = ? LIMIT 1",
      [cpfNum]
    );
    
    if (pessoasExistentes.length > 0) {
      throw new Error("CPF já cadastrado no sistema");
    }
  }

  const [ins] = await conn.query(
    `INSERT INTO pessoas (nome, cpf, data_nascimento, telefone, email)
     VALUES (?,?,?,?,?)`,
    [
      limit(nome, 150), 
      cpfNum || null, 
      toYYYYMMDDorNull(data_nascimento), 
      limit(telefone, 20), 
      limit(email, 150)
    ]
  );
  
  return ins.insertId;
}

/* ========= usuário ========= */
async function createUsuario(conn, usuarioInput, pessoaNome) {
  const { nome = pessoaNome, email, senha, ativo = 1 } = usuarioInput;
  
  if (!email?.trim()) throw new Error("E-mail é obrigatório.");
  if (!senha?.trim()) throw new Error("Senha é obrigatória.");
  if (senha.length < 6) throw new Error("Senha deve ter pelo menos 6 caracteres.");

  // Verifica se e-mail já existe
  const emailLower = String(email).trim().toLowerCase();
  const [usuariosExistentes] = await conn.query(
    "SELECT id FROM usuarios WHERE email = ? LIMIT 1",
    [emailLower]
  );
  
  if (usuariosExistentes.length > 0) {
    throw new Error("E-mail já cadastrado no sistema");
  }

  const hash = await bcrypt.hash(senha, 10);

  const [ins] = await conn.query(
    `INSERT INTO usuarios (nome, email, senha, ativo) VALUES (?,?,?,?)`,
    [limit(nome, 150), emailLower, hash, ativo ? 1 : 0]
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

/* ========= usuário × pessoa ========= */
async function linkUsuarioPessoa(conn, empresaId, usuarioId, pessoaId) {
  await conn.query(
    `INSERT IGNORE INTO usuarios_pessoas (empresa_id, usuario_id, pessoa_id)
     VALUES (?,?,?)`,
    [empresaId, usuarioId, pessoaId]
  );
}

/* ========= cargos/funcionários ========= */
async function getOrCreateCargoByName(conn, empresaId, nomeCargo) {
  const [rows] = await conn.query(
    "SELECT id FROM cargos WHERE empresa_id = ? AND nome = ? LIMIT 1",
    [empresaId, nomeCargo]
  );
  
  if (rows.length) return rows[0].id;

  const [ins] = await conn.query(
    "INSERT INTO cargos (empresa_id, nome, descricao, ativo) VALUES (?,?,?,1)",
    [empresaId, nomeCargo, "Cargo padrão gerado automaticamente no registro"]
  );
  
  return ins.insertId;
}

async function createFuncionario(conn, { empresaId, pessoaId, cargoId }) {
  // Verifica se já existe funcionário para esta pessoa na empresa
  const [funcionariosExistentes] = await conn.query(
    "SELECT id FROM funcionarios WHERE empresa_id = ? AND pessoa_id = ? LIMIT 1",
    [empresaId, pessoaId]
  );
  
  if (funcionariosExistentes.length > 0) {
    return funcionariosExistentes[0].id;
  }

  const [ins] = await conn.query(
    `INSERT INTO funcionarios
       (empresa_id, pessoa_id, cargo_id, regime, salario_base, valor_hora, ativo)
     VALUES (?,?,?,?,?,?,1)`,
    [empresaId, pessoaId, cargoId, "MENSALISTA", 0.00, null]
  );

  return ins.insertId;
}

/* ========= rotas ========= */

/**
 * POST /api/registro/completo
 * Body: { 
 *   empresa: { cnpj, ... }, 
 *   pessoa: { nome, cpf, ... }, 
 *   usuario: { email, senha, ... } 
 * }
 */
router.post("/completo", async (req, res) => {
  const { empresa = {}, pessoa = {}, usuario = {} } = req.body || {};
  let conn;
  
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    // PASSO 1: Consulta CNPJ na API se necessário (quando apenas o CNPJ foi enviado)
    let dadosEmpresa = { ...empresa };
    
    if (empresa.cnpj && !empresa.razao_social) {
      try {
        console.log("Consultando CNPJ na API:", empresa.cnpj);
        const dadosAPI = await consultaCNPJnaAPI(empresa.cnpj);
        dadosEmpresa = { ...dadosAPI, ...empresa }; // Mescla dados da API com dados do formulário
        console.log("Dados da API obtidos com sucesso");
      } catch (apiError) {
        console.warn("Consulta API falhou, usando dados manuais:", apiError.message);
        // Continua com os dados manuais se a API falhar
      }
    }

    // PASSO 2: Cria empresa
    const empresaId = await createEmpresa(conn, dadosEmpresa);
    console.log("Empresa criada com ID:", empresaId);
    
    // PASSO 3: Cria pessoa
    const pessoaId = await createPessoa(conn, pessoa);
    console.log("Pessoa criada com ID:", pessoaId);
    
    // PASSO 4: Cria usuário
    const usuarioId = await createUsuario(conn, usuario, pessoa.nome);
    console.log("Usuário criado com ID:", usuarioId);
    
    // PASSO 5: Cria perfil de administrador
    const perfilId = await getOrCreatePerfilAdministrador(conn, empresaId);
    console.log("Perfil criado/obtido com ID:", perfilId);

    // PASSO 6: Faz os vínculos
    await linkUsuarioPerfil(conn, empresaId, usuarioId, perfilId);
    await linkUsuarioPessoa(conn, empresaId, usuarioId, pessoaId);
    console.log("Vínculos criados");

    // PASSO 7: Cria cargo e funcionário
    const cargoId = await getOrCreateCargoByName(conn, empresaId, "colaborador");
    console.log("Cargo criado/obtido com ID:", cargoId);
    
    const funcionarioId = await createFuncionario(conn, {
      empresaId,
      pessoaId,
      cargoId
    });
    console.log("Funcionário criado com ID:", funcionarioId);

    await conn.commit();
    
    return res.json({
      ok: true,
      empresa_id: empresaId,
      pessoa_id: pessoaId,
      usuario_id: usuarioId,
      perfil_id: perfilId,
      funcionario_id: funcionarioId,
      message: "Cadastro realizado com sucesso!"
    });
    
  } catch (error) {
    if (conn) await conn.rollback();
    console.error("REGISTER_COMPLETO_ERR", error);
    
    const msg = String(error?.message || "");
    let friendly = "Não foi possível concluir o cadastro.";
    
    if (msg.includes("CNPJ já cadastrado") || 
        msg.includes("CPF já cadastrado") || 
        msg.includes("E-mail já cadastrado") ||
        msg.includes("Duplicate entry") ||
        msg.includes("CNPJ inválido") ||
        msg.includes("CPF inválido")) {
      friendly = msg;
    }
    
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * POST /api/registro/vincular-admin
 * Body: { empresa: { cnpj, ... } }  (usuário já autenticado)
 */
router.post("/vincular-admin", async (req, res) => {
  let userId = req.userId || null;
  
  if (!userId) {
    try {
      const { token } = req.cookies || {};
      if (!token) {
        return res.status(401).json({ ok: false, error: "Não autenticado. Token não encontrado." });
      }
      
      const tokenParts = token.split('.');
      if (tokenParts.length !== 3) {
        return res.status(401).json({ ok: false, error: "Token inválido." });
      }
      
      const payload = JSON.parse(Buffer.from(tokenParts[1], "base64").toString() || "{}");
      userId = payload.sub || payload.userId || payload.id;
      
      if (!userId) {
        return res.status(401).json({ ok: false, error: "Token não contém informações de usuário." });
      }
    } catch (tokenError) {
      console.error("Token parsing error:", tokenError);
      return res.status(401).json({ ok: false, error: "Erro ao processar token de autenticação." });
    }
  }

  let conn;
  try {
    const { empresa = {} } = req.body || {};
    
    if (!empresa.cnpj) {
      return res.status(400).json({ ok: false, error: "CNPJ da empresa é obrigatório." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Consulta API se necessário
    let dadosEmpresa = { ...empresa };
    
    if (empresa.cnpj && !empresa.razao_social) {
      try {
        console.log("Consultando CNPJ na API para vínculo:", empresa.cnpj);
        const dadosAPI = await consultaCNPJnaAPI(empresa.cnpj);
        dadosEmpresa = { ...dadosAPI, ...empresa };
      } catch (apiError) {
        console.warn("Consulta API falhou no vínculo:", apiError.message);
      }
    }

    const empresaId = await createEmpresa(conn, dadosEmpresa);
    const perfilId = await getOrCreatePerfilAdministrador(conn, empresaId);
    await linkUsuarioPerfil(conn, empresaId, userId, perfilId);

    await conn.commit();
    
    return res.json({ 
      ok: true, 
      empresa_id: empresaId, 
      perfil_id: perfilId,
      message: "Empresa vinculada com sucesso!"
    });
    
  } catch (error) {
    if (conn) await conn.rollback();
    console.error("REGISTER_VINCULAR_ERR", error);
    
    const msg = String(error?.message || "");
    let friendly = "Não foi possível vincular a empresa ao usuário.";
    
    if (msg.includes("CNPJ já cadastrado") || 
        msg.includes("Duplicate entry") ||
        msg.includes("CNPJ inválido")) {
      friendly = msg;
    }
    
    return res.status(400).json({ ok: false, error: friendly });
  } finally {
    if (conn) conn.release();
  }
});

export default router;