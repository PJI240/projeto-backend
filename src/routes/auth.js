import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = Router();

/**
 * Opções de cookie:
 * - Em produção (Railway, HTTPS, domínios diferentes): secure + SameSite=none
 * - Em dev/local: lax + secure=false
 * - Permite override por env: COOKIE_SECURE, COOKIE_SAMESITE
 */
function cookieOptions() {
  const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";

  // valores opcionais vindos do ambiente
  const envSecure = String(process.env.COOKIE_SECURE || "").toLowerCase();
  const envSameSite = (process.env.COOKIE_SAMESITE || "").toLowerCase();

  // defaults
  let secure = false;
  let sameSite = "lax";

  if (isProd) {
    secure = true;
    sameSite = "none";
  }

  // overrides por env (opcionais)
  if (envSecure === "true") secure = true;
  if (envSecure === "false") secure = false;
  if (["lax", "strict", "none"].includes(envSameSite)) sameSite = envSameSite;

  // navegadores exigem secure quando SameSite=none
  if (sameSite === "none" && !secure) secure = true;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
    maxAge: 24 * 60 * 60 * 1000, // 1 dia
  };
}

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
      `SELECT id, nome, email, senha AS senhaHash, ativo
         FROM usuarios
        WHERE LOWER(email) = ? 
        LIMIT 1`,
      [email]
    );

    const user = rows?.[0];
    if (!user || user.ativo !== 1) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(senha, String(user.senhaHash || ""));
    if (!ok) {
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

router.get("/me", (req, res) => {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.json({ ok: true, user: null });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({
      ok: true,
      user: { id: payload.sub, email: payload.email, nome: payload.nome },
    });
  } catch (e) {
    // token inválido/expirado → sem erro duro; apenas sem sessão
    return res.json({ ok: true, user: null });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", cookieOptions());
  return res.json({ ok: true });
});

export default router;
