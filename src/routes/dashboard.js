// src/routes/dashboard.js
import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

// Middleware para verificar autenticação
const requireAuth = (req, res, next) => {
  const { token } = req.cookies || {};
  
  if (!token) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  
  try {
    // Verifica o token JWT
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
};

// Rota do resumo do dashboard
router.get("/resumo", requireAuth, async (req, res) => {
  try {
    // Busca contagens do banco (exemplo - ajuste conforme suas tabelas)
    const [usuariosRows] = await pool.query("SELECT COUNT(*) as count FROM usuarios WHERE ativo = 1");
    const [pessoasRows] = await pool.query("SELECT COUNT(*) as count FROM pessoas");
    const [empresasRows] = await pool.query("SELECT COUNT(*) as count FROM empresas WHERE ativa = 1");

    const counts = {
      usuarios: usuariosRows[0].count,
      pessoas: pessoasRows[0].count,
      empresas: empresasRows[0].count
    };

    res.json({
      ok: true,
      counts
    });
  } catch (error) {
    console.error("DASHBOARD_RESUMO_ERROR:", error);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

export default router;
