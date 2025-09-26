// src/routes/dashboard.js
import { Router } from "express";
import { pool } from "../db.js"; 

const router = Router();

/**
 * GET /api/dashboard/resumo
 * Totais básicos do sistema (campos reais do seu schema)
 */
router.get("/resumo", async (_req, res) => {
  try {
    const [usuariosP, pessoasP, empresasP] = await Promise.all([
      pool.query("SELECT COUNT(*) AS total FROM usuarios WHERE ativo = TRUE"),
      pool.query("SELECT COUNT(*) AS total FROM pessoas"),
      pool.query("SELECT COUNT(*) AS total FROM empresas WHERE ativa = TRUE"),
    ]);

    const usuarios = usuariosP[0][0]?.total ?? 0;
    const pessoas  = pessoasP[0][0]?.total ?? 0;
    const empresas = empresasP[0][0]?.total ?? 0;

    res.json({
      ok: true,
      counts: { usuarios, pessoas, empresas },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("DASHBOARD_RESUMO_ERROR", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;
