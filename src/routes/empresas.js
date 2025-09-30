// src/routes/empresas.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();
const onlyDigits = (s = "") => String(s).replace(/\D+/g, "");

/* ----------------- Auth & helpers ----------------- */
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
  return rows.map(r => r.empresa_id);
}

async function isDev(userId) {
  const [rows] = await pool.query(
    `SELECT 1
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ? AND LOWER(p.nome) = 'desenvolvedor'
      LIMIT 1`,
    [userId]
  );
  return rows.length > 0;
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

/* ----------------- Consulta CNPJ (mantida) ----------------- */
// fetch c/ timeout (node18 tem global fetch)
async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(t);
  }
}
router.post("/consulta-cnpj", async (req, res) => {
  try {
    const num = onlyDigits(req.body?.cnpj);
    if (num.length !== 14) {
      return res.status(400).json({ ok: false, error: "CNPJ inválido (14 dígitos)." });
    }
    if (num === "00000000000000") {
      return res.status(400).json({ ok: false, error: "CNPJ reservado ao sistema (GLOBAL)." });
    }

    const { ok, status, data } = await fetchJson(`https://www.receitaws.com.br/v1/cnpj/${num}`);
    if (!ok || !data || data.status !== "OK") {
      return res.status(502).json({ ok: false, error: "Falha ao consultar a Receita.", upstream: status });
    }

    const d = data;
    const empresa = {
      razao_social: d.nome || "",
      nome_fantasia: d.fantasia || "",
      cnpj: num,
      inscricao_estadual: null,
      data_abertura: d.abertura ? d.abertura.split("/").reverse().join("-") : null,
      telefone: (String(d.telefone || "").split(/[\/,;]+/)[0] || "").trim(),
      email: d.email || "",
      capital_social: (() => {
        const raw = String(d.capital_social ?? "").replace(/[^\d,.-]/g, "").replace(",", ".");
        const val = parseFloat(raw);
        return Number.isFinite(val) ? val : null;
      })(),
      natureza_juridica: d.natureza_juridica || "",
      situacao_cadastral: d.situicao || d.situacao || "",
      data_situacao: d.data_situicao ? d.data_situicao.split("/").reverse().join("-") : null,
      socios_receita: d.qsa || [],
    };
    return res.json({ ok: true, empresa });
  } catch (e) {
    const msg = /abort/i.test(String(e?.message || "")) ? "Tempo de consulta esgotado." : "Erro interno na consulta.";
    return res.status(500).json({ ok: false, error: msg });
  }
});

/* ----------------- Atalhos de escopo ----------------- */
router.get("/minhas", requireAuth, async (req, res) => {
  try {
    const ids = await getUserEmpresaIds(req.userId);
    if (!ids.length) return res.json({ ok: true, empresas: [] });
    const [rows] = await pool.query(
      `SELECT id, razao_social, nome_fantasia, cnpj, email, telefone, ativa
         FROM empresas
        WHERE id IN (?)
        ORDER BY razao_social`,
      [ids]
    );
    res.json({ ok: true, empresas: rows });
  } catch (e) {
    res.status(400).json({ ok: false, error: "Falha ao listar empresas do usuário." });
  }
});

router.get("/minha", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, null);
    const [[row]] = await pool.query(`SELECT * FROM empresas WHERE id = ? LIMIT 1`, [empresaId]);
    if (!row) return res.status(404).json({ ok: false, error: "Empresa não encontrada." });
    res.json({ ok: true, empresa: row });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || "Falha ao obter empresa." });
  }
});

/* ----------------- CRUD ----------------- */
// Lista geral: apenas DEV vê todas; admin/func vê só as suas
router.get("/", requireAuth, async (req, res) => {
  try {
    if (await isDev(req.userId)) {
      const [rows] = await pool.query(
        `SELECT id, razao_social, nome_fantasia, cnpj, email, telefone, ativa
           FROM empresas
          ORDER BY razao_social`
      );
      return res.json({ ok: true, empresas: rows });
    }
    // não-dev → delega para /minhas
    const ids = await getUserEmpresaIds(req.userId);
    if (!ids.length) return res.json({ ok: true, empresas: [] });
    const [rows] = await pool.query(
      `SELECT id, razao_social, nome_fantasia, cnpj, email, telefone, ativa
         FROM empresas
        WHERE id IN (?)
        ORDER BY razao_social`,
      [ids]
    );
    return res.json({ ok: true, empresas: rows });
  } catch (e) {
    res.status(400).json({ ok: false, error: "Falha ao listar empresas." });
  }
});

// Detalhe: permitido se (dev) ou (empresa pertence ao usuário)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (await isDev(req.userId)) {
      const [[row]] = await pool.query(`SELECT * FROM empresas WHERE id = ? LIMIT 1`, [id]);
      if (!row) return res.status(404).json({ ok: false, error: "Empresa não encontrada." });
      return res.json({ ok: true, empresa: row });
    }
    const ids = await getUserEmpresaIds(req.userId);
    if (!ids.includes(id)) return res.status(404).json({ ok: false, error: "Empresa não autorizada." });

    const [[row]] = await pool.query(`SELECT * FROM empresas WHERE id = ? LIMIT 1`, [id]);
    if (!row) return res.status(404).json({ ok: false, error: "Empresa não encontrada." });
    return res.json({ ok: true, empresa: row });
  } catch (e) {
    res.status(400).json({ ok: false, error: "Falha ao obter empresa." });
  }
});

// Atualiza (precisa pertencer ao usuário ou ser dev)
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const dev = await isDev(req.userId);
    if (!dev) {
      const ids = await getUserEmpresaIds(req.userId);
      if (!ids.includes(id)) return res.status(403).json({ ok: false, error: "Sem acesso a esta empresa." });
    }

    const {
      razao_social, nome_fantasia, email, telefone, ativa,
      inscricao_estadual, data_abertura, capital_social,
      natureza_juridica, situacao_cadastral, data_situacao
    } = req.body || {};

    await pool.query(
      `UPDATE empresas SET
          razao_social = ?, nome_fantasia = ?, email = ?, telefone = ?,
          ativa = ?, inscricao_estadual = ?, data_abertura = ?,
          capital_social = ?, natureza_juridica = ?, situacao_cadastral = ?,
          data_situacao = ?
        WHERE id = ?`,
      [
        razao_social || null, nome_fantasia || null, email || null, (telefone || "").split(/[\/,;]+/)[0] || null,
        ativa ? 1 : 0, inscricao_estadual || null, data_abertura || null,
        Number.isFinite(+capital_social) ? +capital_social : null,
        natureza_juridica || null, situacao_cadastral || null,
        data_situacao || null, id
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: "Falha ao atualizar empresa." });
  }
});
