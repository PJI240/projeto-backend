// src/routes/empresas.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";
import { ensureAdminProfile, backfillAdminProfiles } from "../lib/roles.js";

const router = express.Router();
const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

// --- auth util ---
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

// ---------------- consulta CNPJ (mantida) ----------------
async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } finally {
    clearTimeout(timer);
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
      return res.status(502).json({
        ok: false,
        error: "Falha ao consultar a Receita (tente novamente em instantes).",
        upstream: status,
      });
    }

    const d = data;
    const empresa = {
      razao_social: d.nome || "",
      nome_fantasia: d.fantasia || "",
      cnpj: num,
      inscricao_estadual: null,
      data_abertura: d.abertura ? d.abertura.split("/").reverse().join("-") : null,
      telefone: d.telefone || "",
      email: d.email || "",
      capital_social: (() => {
        const raw = String(d.capital_social ?? "").replace(/[^\d,.-]/g, "").replace(",", ".");
        const val = parseFloat(raw);
        return Number.isFinite(val) ? val : null;
      })(),
      natureza_juridica: d.natureza_juridica || "",
      situacao_cadastral: d.situacao || "",
      data_situacao: d.data_situicao ? d.data_situicao.split("/").reverse().join("-") : null,
      socios_receita: JSON.stringify(d.qsa || []),
    };

    return res.json({ ok: true, empresa });
  } catch (e) {
    console.error("CNPJ_API_ERR", e?.message);
    const msg = /abort/i.test(String(e?.message || "")) ? "Tempo de consulta esgotado." : "Erro interno na consulta de CNPJ.";
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ---------------- CRUD de empresas (mínimo necessário) ----------------

// GET /api/empresas -> se desenvolvedor: todas; senão: apenas as do usuário
router.get("/", requireAuth, async (req, res) => {
  try {
    // pega roles
    const [[isDev]] = await pool.query(`
      SELECT 1 AS ok FROM usuarios_perfis up
      JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ? AND LOWER(p.nome) = 'desenvolvedor' LIMIT 1
    `, [req.userId]);

    let rows;
    if (isDev) {
      [rows] = await pool.query(`SELECT * FROM empresas ORDER BY razao_social ASC`);
    } else {
      const ids = await getUserEmpresaIds(req.userId);
      if (!ids.length) return res.json({ ok: true, empresas: [] });
      [rows] = await pool.query(
        `SELECT * FROM empresas WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY razao_social ASC`,
        ids
      );
    }
    return res.json({ ok: true, empresas: rows });
  } catch (e) {
    console.error("EMPRESAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: "Falha ao listar empresas." });
  }
});

// POST /api/empresas -> cria empresa e GARANTE perfil Administrador
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const {
      razao_social, nome_fantasia, cnpj,
      inscricao_estadual, data_abertura,
      telefone, email, capital_social,
      natureza_juridica, situacao_cadastral,
      data_situacao, socios_receita,
      ativa = 1
    } = req.body || {};

    const cnpjNum = onlyDigits(cnpj);
    if (cnpjNum.length !== 14) return res.status(400).json({ ok: false, error: "CNPJ inválido." });
    if (cnpjNum === "00000000000000") return res.status(400).json({ ok: false, error: "CNPJ reservado (GLOBAL)." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [ins] = await conn.query(
      `INSERT INTO empresas
       (razao_social, nome_fantasia, cnpj, inscricao_estadual, data_abertura, telefone, email,
        capital_social, natureza_juridica, situacao_cadastral, data_situacao, socios_receita, ativa)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        razao_social, nome_fantasia, cnpjNum, inscricao_estadual || null, data_abertura || null,
        telefone || null, email || null, capital_social ?? null, natureza_juridica || null,
        situacao_cadastral || null, data_situacao || null, socios_receita || "[]", ativa ? 1 : 0
      ]
    );
    const empresaId = ins.insertId;

    // Garante perfil Administrador
    await ensureAdminProfile(empresaId);

    await conn.commit();
    return res.json({ ok: true, id: empresaId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("EMPRESA_CREATE_ERR", e);
    const msg = /Duplicate entry/i.test(String(e?.message || "")) ? "CNPJ já cadastrado." : "Falha ao criar empresa.";
    return res.status(400).json({ ok: false, error: msg });
  } finally {
    if (conn) conn.release();
  }
});

// manutenção: cria perfil Admin onde faltar (idempotente)
router.post("/_backfill-admin-perfil", requireAuth, async (_req, res) => {
  try {
    await backfillAdminProfiles();
    return res.json({ ok: true });
  } catch (e) {
    console.error("BACKFILL_ADMIN_ERR", e);
    return res.status(500).json({ ok: false, error: "Falha ao garantir perfis admin." });
  }
});

export default router;