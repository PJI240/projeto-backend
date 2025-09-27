// src/routes/empresas.js
import express from "express";

const router = express.Router();
const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

// helper: fetch com timeout
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

export default router;
