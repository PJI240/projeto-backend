// src/routes/empresas.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ===================== helpers util ===================== */

const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

function normStr(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

function toDateOrNull(s) {
  const v = normStr(s);
  if (!v) return null;
  // aceita "YYYY-MM-DD" ou "DD/MM/YYYY"
  const mIso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mBr  = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mIso) return v;
  if (mBr) return `${mBr[3]}-${mBr[2]}-${mBr[1]}`;
  return null;
}

function jsonOrStringify(input) {
  if (input == null || input === "") return "[]";
  if (typeof input === "string") {
    try {
      return JSON.stringify(JSON.parse(input));
    } catch {
      return JSON.stringify([String(input)]);
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "[]";
  }
}

function isValidCNPJ(raw) {
  const cnpj = onlyDigits(raw);
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(cnpj)) return false;

  const calc = (slice) => {
    let pos = slice.length - 7, sum = 0;
    for (let i = slice.length; i >= 1; i--) {
      sum += Number(slice[slice.length - i]) * pos--;
      if (pos < 2) pos = 9;
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const n = cnpj.substring(0, 12);
  const dv1 = calc(n);
  const dv2 = calc(n + dv1);
  return cnpj === n + String(dv1) + String(dv2);
}

function normalizeEmpresaInput(body) {
  const cnpjNum = onlyDigits(body?.cnpj || "");
  return {
    razao_social:        normStr(body?.razao_social),
    nome_fantasia:       normStr(body?.nome_fantasia),
    cnpj:                cnpjNum || null,
    inscricao_estadual:  normStr(body?.inscricao_estadual),
    data_abertura:       toDateOrNull(body?.data_abertura),
    telefone:            normStr(body?.telefone),
    email:               normStr(body?.email),
    capital_social:      body?.capital_social === "" || body?.capital_social == null ? null : Number(body.capital_social),
    natureza_juridica:   normStr(body?.natureza_juridica),
    situacao_cadastral:  normStr(body?.situacao_cadastral),
    data_situacao:       toDateOrNull(body?.data_situicao || body?.data_situacao), // aceita as 2 chaves
    socios_receita:      jsonOrStringify(body?.socios_receita),
    ativa:               body?.ativa ? 1 : 0,
  };
}

/* ===================== helpers auth/scope ===================== */

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => String(r.perfil || "").toLowerCase());
}

function isDev(roles = []) {
  return roles.map((r) => String(r).toLowerCase()).includes("desenvolvedor");
}

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

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

async function ensureCanAccessEmpresa(userId, empresaId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (empresas.includes(Number(empresaId))) return true;

  throw new Error("Empresa não autorizada.");
}

/* =========================================================
   1) Consulta CNPJ (pública) — checa banco e PROXY para /api/registro/consulta-cnpj
   ========================================================= */

// 🔓 PÚBLICA — não usa requireAuth
router.post("/consulta-cnpj", async (req, res) => {
  try {
    const raw = req.body?.cnpj;
    const num = onlyDigits(raw);
    if (num.length !== 14) {
      return res.status(400).json({ ok: false, error: "CNPJ inválido (14 dígitos)." });
    }
    if (num === "00000000000000") {
      return res.status(400).json({ ok: false, error: "CNPJ reservado ao sistema (GLOBAL)." });
    }

    // 1) Verifica no banco ANTES de chamar a API interna
    const [rows] = await pool.query(
      `SELECT id, razao_social, cnpj
         FROM empresas
        WHERE REPLACE(REPLACE(REPLACE(cnpj,'/',''),'.',''),'-','') = ?
           OR cnpj = ?
        LIMIT 1`,
      [num, raw]
    );
    if (rows.length) {
      const ja = rows[0];
      return res.status(409).json({
        ok: false,
        code: "already_registered",
        error: "Sua empresa já tem cadastro, procure o seu administrador.",
        empresa_id: ja.id,
        razao_social: ja.razao_social
      });
    }

    // 2) Não existe? Encaminha para a SUA API interna (não chama ReceitaWS aqui)
    const SELF_ORIGIN =
      process.env.SELF_ORIGIN ||
      `http://127.0.0.1:${process.env.PORT || 4000}`;

    const resp = await fetch(`${SELF_ORIGIN}/api/registro/consulta-cnpj`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // público — sem cookies
      body: JSON.stringify({ cnpj: num }),
    });

    const data = await resp.json().catch(() => null);
    return res.status(resp.status).json(data ?? { ok: false, error: "Falha na consulta interna." });
  } catch (e) {
    console.error("EMPRESAS_CONSULTA_CNPJ_PROXY_ERR", e?.message || e);
    return res.status(500).json({ ok: false, error: "Erro ao consultar CNPJ." });
  }
});

/* =========================================================
   2) A PARTIR DAQUI: tudo exige autenticação
   ========================================================= */

router.use(requireAuth);

/**
 * GET /api/empresas?scope=mine|all
 * - dev: pode usar scope=all (todas)
 * - demais: sempre mine (vinculadas)
 */
router.get("/", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const scope = String(req.query.scope || "mine").toLowerCase();

    if (scope === "all") {
      if (!isDev(roles)) return res.status(403).json({ ok: false, error: "Acesso negado." });
      const [rows] = await pool.query(
        `SELECT id, razao_social, nome_fantasia, cnpj, ativa
           FROM empresas
          ORDER BY razao_social ASC`
      );
      return res.json({ ok: true, empresas: rows, scope: "all" });
    }

    // mine
    const [rows] = await pool.query(
      `SELECT e.id, e.razao_social, e.nome_fantasia, e.cnpj, e.ativa
         FROM empresas e
         JOIN empresas_usuarios eu ON eu.empresa_id = e.id AND eu.ativo = 1
        WHERE eu.usuario_id = ?
        ORDER BY e.razao_social ASC`,
      [req.userId]
    );
    return res.json({ ok: true, empresas: rows, scope: "mine" });
  } catch (e) {
    console.error("EMP_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar empresas." });
  }
});

/**
 * GET /api/empresas/:id
 * Detalhe (dev ou vinculado)
 */
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureCanAccessEmpresa(req.userId, id);

    const [[row]] = await pool.query(
      `SELECT id, razao_social, nome_fantasia, cnpj, inscricao_estadual,
              data_abertura, telefone, email, capital_social, natureza_juridica,
              situacao_cadastral, data_situacao, socios_receita, ativa
         FROM empresas
        WHERE id = ?
        LIMIT 1`,
      [id]
    );
    if (!row) return res.status(404).json({ ok: false, error: "Empresa não encontrada." });

    return res.json({ ok: true, empresa: row });
  } catch (e) {
    console.error("EMP_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao obter empresa." });
  }
});

/**
 * POST /api/empresas
 * Cria (somente desenvolvedor)
 */
router.post("/", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    if (!isDev(roles)) return res.status(403).json({ ok: false, error: "Apenas desenvolvedor pode criar empresas." });

    const e = normalizeEmpresaInput(req.body);
    if (!e.razao_social || !e.cnpj) {
      return res.status(400).json({ ok: false, error: "Razão social e CNPJ são obrigatórios." });
    }
    if (!isValidCNPJ(e.cnpj)) return res.status(400).json({ ok: false, error: "CNPJ inválido." });
    if (e.cnpj === "00000000000000") return res.status(400).json({ ok: false, error: "CNPJ reservado (GLOBAL)." });

    // duplicidade por CNPJ (normalizado)
    const [[dupe]] = await pool.query(
      `SELECT id FROM empresas
        WHERE REPLACE(REPLACE(REPLACE(cnpj,'/',''),'.',''),'-','') = ?
        LIMIT 1`,
      [e.cnpj]
    );
    if (dupe) return res.status(409).json({ ok: false, error: "Já existe empresa com este CNPJ." });

    const [ins] = await pool.query(
      `INSERT INTO empresas
         (razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura, telefone, email,
          capital_social, natureza_juridica, situacao_cadastral, data_situacao, socios_receita, ativa)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        e.razao_social, e.nome_fantasia, e.cnpj, e.inscricao_estadual, e.data_abertura, e.telefone, e.email,
        e.capital_social, e.natureza_juridica, e.situacao_cadastral, e.data_situacao, e.socios_receita, e.ativa ? 1 : 0
      ]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("EMP_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar empresa." });
  }
});

/**
 * PUT /api/empresas/:id
 * Atualiza (dev ou vinculado). CNPJ NÃO é alterado aqui.
 */
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureCanAccessEmpresa(req.userId, id);

    const e = normalizeEmpresaInput(req.body);
    // não permitir troca de CNPJ aqui
    delete e.cnpj;

    await pool.query(
      `UPDATE empresas
          SET razao_social = ?, nome_fantasia = ?, inscricao_estadual = ?, data_abertura = ?,
              telefone = ?, email = ?, capital_social = ?, natureza_juridica = ?,
              situacao_cadastral = ?, data_situacao = ?, socios_receita = ?, ativa = ?
        WHERE id = ?`,
      [
        e.razao_social, e.nome_fantasia, e.inscricao_estadual, e.data_abertura,
        e.telefone, e.email, e.capital_social, e.natureza_juridica,
        e.situacao_cadastral, e.data_situacao, e.socios_receita, e.ativa ? 1 : 0,
        id
      ]
    );
    return res.json({ ok: true });
  } catch (e) {
    console.error("EMP_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar empresa." });
  }
});

export default router;