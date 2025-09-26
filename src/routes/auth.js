import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = Router();

/**
 * Em produção (Railway, HTTPS, domínios diferentes), força:
 *  - secure: true
 *  - sameSite: "none"
 * Em dev/local, usa lidas do .env ou cai no padrão lax/secure:false.
 */
function cookieOptions() {
  const isProd = String(process.env.NODE_ENV).toLowerCase() === "production";

  // valores do .env (se quiser forçar manualmente)
  const envSecure = String(process.env.COOKIE_SECURE || "").toLowerCase();
  const envSameSite = (process.env.COOKIE_SAMESITE || "").toLowerCase();

  // default locais (dev)
  let secure = false;
  let sameSite = "lax";

  if (isProd) {
    // produção: Railway (HTTPS) + front em outro domínio -> precisa 'secure + none'
    secure = true;
    sameSite = "none";
  }

  // permitir override por env se quiser (opcional)
  if (envSecure === "true") secure = true;
  if (envSecure === "false") secure = false;
  if (["lax", "strict", "none"].includes(envSameSite)) sameSite = envSameSite;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",                 // garante que vale para todo o site
    maxAge: 24 * 60 * 60 * 1000
  };
}

router.post("/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const [rows] = await pool.query(
      "SELECT id, nome, email, senha_hash AS senhaHash, ativo FROM usuarios WHERE email = ? LIMIT 1",
      [email]
    );

    const user = rows?.[0];
    if (!user || user.ativo !== 1) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const ok = await bcrypt.compare(String(senha), String(user.senhaHash || ""));
    if (!ok) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieOptions());
    return res.json({ ok: true, user: { id: user.id, email: user.email, nome: user.nome } });
  } catch (e) {
    console.error("LOGIN_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

router.get("/me", async (req, res) => {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.json({ ok: true, user: null });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    return res.json({
      ok: true,
      user: { id: payload.sub, email: payload.email, nome: payload.nome }
    });
  } catch {
    return res.json({ ok: true, user: null });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", cookieOptions());
  return res.json({ ok: true });
});

export default router;
