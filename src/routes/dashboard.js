import { Router } from "express";
import db from "../db.js"; // seu pool/conexão mysql2/promise

const router = Router();

/**
 * GET /api/dashboard/resumo
 * Retorna totais básicos do sistema.
 * counts: { usuarios, pessoas, empresas }
 */
router.get("/resumo", async (req, res) => {
  try {
    // executa em paralelo para ficar rápido
    const [usuariosP, pessoasP, empresasP] = await Promise.all([
      db.query("SELECT COUNT(*) AS total FROM usuarios WHERE ativo = TRUE"),
      db.query("SELECT COUNT(*) AS total FROM pessoas"),
      db.query("SELECT COUNT(*) AS total FROM empresas WHERE ativa = TRUE"),
    ]);

    const usuarios = usuariosP[0][0]?.total ?? 0;
    const pessoas = pessoasP[0][0]?.total ?? 0;
    const empresas = empresasP[0][0]?.total ?? 0;

    res.json({
      ok: true,
      counts: { usuarios, pessoas, empresas },
      // útil pro futuro (exibir data do snapshot):
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Erro em /api/dashboard/resumo:", err);
    res.status(500).json({ ok: false, error: "Falha ao obter resumo" });
  }
});

export default router;
