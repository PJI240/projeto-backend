import { Router } from "express";
import db from "../db.js"; // importa a conexão MySQL

const router = Router();

/**
 * GET /api/dashboard/resumo
 * Retorna contagem básica do sistema
 */
router.get("/resumo", async (req, res) => {
  try {
    // executa em paralelo para mais performance
    const [usuariosRes, pessoasRes, empresasRes] = await Promise.all([
      db.query("SELECT COUNT(*) AS total FROM usuarios WHERE ativo = TRUE"),
      db.query("SELECT COUNT(*) AS total FROM pessoas"),
      db.query("SELECT COUNT(*) AS total FROM empresas WHERE ativa = TRUE"),
    ]);

    const usuarios = usuariosRes[0][0].total;
    const pessoas = pessoasRes[0][0].total;
    const empresas = empresasRes[0][0].total;

    res.json({
      ok: true,
      counts: { usuarios, pessoas, empresas },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Erro ao obter resumo:", err);
    res.status(500).json({ ok: false, error: "Erro interno do servidor" });
  }
});

export default router;
