// routes/empresas.js
import express from "express";
import axios from "axios";

const router = express.Router();
const onlyDigits = (s = "") => (s || "").replace(/\D+/g, "");

// POST /api/empresas/consulta-cnpj
router.post("/consulta-cnpj", async (req, res) => {
  try {
    const { cnpj } = req.body || {};
    const num = onlyDigits(cnpj);
    if (num.length !== 14) {
      return res.status(400).json({ ok: false, error: "CNPJ inválido (14 dígitos)." });
    }
    if (num === "00000000000000") {
      return res.status(400).json({ ok: false, error: "CNPJ reservado ao sistema (GLOBAL)." });
    }

    // consulta API ReceitaWS (ou espelho)
    const url = `https://www.receitaws.com.br/v1/cnpj/${num}`;
    const r = await axios.get(url, { timeout: 15000 });

    if (!r.data || r.data.status !== "OK") {
      return res.status(400).json({ ok: false, error: "Não foi possível consultar a Receita." });
    }

    // mapear campos para o formato da tabela empresas
    const emp = r.data;
    const empresa = {
      razao_social: emp.nome || "",
      nome_fantasia: emp.fantasia || "",
      cnpj: num,
      inscricao_estadual: null,
      data_abertura: emp.abertura
        ? emp.abertura.split("/").reverse().join("-")
        : null,
      telefone: emp.telefone || "",
      email: emp.email || "",
      capital_social: parseFloat(
        (emp.capital_social || "0").replace(/[^\d,.-]/g, "").replace(",", ".")
      ) || null,
      natureza_juridica: emp.natureza_juridica || "",
      situacao_cadastral: emp.situacao || "",
      data_situacao: emp.data_situicao
        ? emp.data_situicao.split("/").reverse().join("-")
        : null,
      socios_receita: JSON.stringify(emp.qsa || []),
    };

    res.json({ ok: true, empresa });
  } catch (e) {
    console.error("CNPJ_API_ERR", e.message);
    res.status(500).json({ ok: false, error: "Erro ao consultar CNPJ." });
  }
});

export default router;
