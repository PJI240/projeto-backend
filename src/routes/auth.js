import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = Router();

/**
 * Opções de cookie:
 * - Produção (Railway, HTTPS, domínios diferentes): secure + SameSite=none
 * - Dev/local: lax + secure=false
 * - Override por env: COOKIE_SECURE, COOKIE_SAMESITE
 */
function cookieOptions() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  const envSecure = String(process.env.COOKIE_SECURE || "").toLowerCase();
  const envSameSite = (process.env.COOKIE_SAMESITE || "").toLowerCase();

  let secure = false;
  let sameSite = "lax";

  if (isProd) {
    secure = true;
    sameSite = "none";
  }

  if (envSecure === "true") secure = true;
  if (envSecure === "false") secure = false;
  if (["lax", "strict", "none"].includes(envSameSite)) sameSite = envSameSite;

  if (sameSite === "none" && !secure) secure = true;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: 24 * 60 * 60 * 1000, // 1 dia
  };
}

// ROTA DE REGISTRO - AJUSTADA
router.post("/register", async (req, res) => {
  try {
    let { nome, email, senha } = req.body || {};
    
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Normaliza entrada
    nome = String(nome).trim();
    email = String(email).trim().toLowerCase();
    senha = String(senha);

    // Verifica se email já existe
    const [existingUsers] = await pool.query(
      `SELECT id FROM usuarios WHERE LOWER(email) = ? LIMIT 1`,
      [email]
    );

    if (existingUsers.length > 0) {
      return res.status(409).json({ ok: false, error: "email_already_exists" });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(senha, 12);

    // Insere novo usuário (ativo = TRUE por padrão)
    const [result] = await pool.query(
      `INSERT INTO usuarios (nome, email, senha) 
       VALUES (?, ?, ?)`,
      [nome, email, hashedPassword]
    );

    // Gera token JWT
    const token = jwt.sign(
      { sub: result.insertId, email: email, nome: nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieOptions());
    
    return res.json({
      ok: true,
      user: { id: result.insertId, email: email, nome: nome },
    });
  } catch (e) {
    console.error("REGISTER_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ROTA DE LOGIN - CORRIGIDA
router.post("/login", async (req, res) => {
  try {
    let { email, senha } = req.body || {};
    if (!email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // normaliza entrada
    email = String(email).trim().toLowerCase();
    senha = String(senha);

    const [rows] = await pool.query(
      `SELECT id, nome, email, senha AS senhaDb, ativo
         FROM usuarios
        WHERE LOWER(email) = ?
        LIMIT 1`,
      [email]
    );

    const user = rows?.[0];
    
    // CORREÇÃO: Verifica se usuário existe E ativo é 1 (true no MySQL)
    if (!user || user.ativo !== 1) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    // DEBUG: Adicione estes logs para ver o que está acontecendo
    console.log('🔐 LOGIN DEBUG:');
    console.log('User found:', !!user);
    console.log('Email:', user?.email);
    console.log('Ativo value:', user?.ativo);
    console.log('Ativo type:', typeof user?.ativo);
    console.log('Password starts with:', user?.senhaDb?.substring(0, 10));

    // A senha está como bcrypt, então sempre usa bcrypt.compare
    const passwordOK = await bcrypt.compare(senha, user.senhaDb);
    console.log('Password match:', passwordOK);

    if (!passwordOK) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieOptions());
    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, nome: user.nome },
    });
  } catch (e) {
    console.error("LOGIN_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ROTAS ORIGINAIS (mantidas)
router.get("/me", (req, res) => {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.json({ ok: true, user: null });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({
      ok: true,
      user: { id: payload.sub, email: payload.email, nome: payload.nome },
    });
  } catch (_e) {
    return res.json({ ok: true, user: null });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", cookieOptions());
  return res.json({ ok: true });
});

export default router;
