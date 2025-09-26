// src/routes/dashboard.js
import { Router } from "express";
import { pool } from "../db.js";
import jwt from "jsonwebtoken";

const router = Router();

// Middleware para verificar autenticação
const requireAuth = (req, res, next) => {
  try {
    const { token } = req.cookies || {};
    
    if (!token) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    
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
    console.log('📊 Dashboard resumo requested by:', req.user.email);
    
    // Busca contagens do banco - versão simplificada
    const [usuariosRows] = await pool.query("SELECT COUNT(*) as count FROM usuarios WHERE ativo = 1");
    
    // Se você não tem as tabelas pessoas e empresas ainda, use valores padrão
    const counts = {
      usuarios: usuariosRows[0]?.count || 0,
      pessoas: 0, // Temporário
      empresas: 0  // Temporário
    };

    console.log('📊 Counts:', counts);
    
    res.json({
      ok: true,
      counts,
      user: req.user
    });
  } catch (error) {
    console.error("DASHBOARD_RESUMO_ERROR:", error);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// Rota de exemplo para outros endpoints do dashboard
router.get("/user-info", requireAuth, (req, res) => {
  res.json({
    ok: true,
    user: req.user
  });
});

export default router;
