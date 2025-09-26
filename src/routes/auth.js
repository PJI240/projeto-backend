import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = Router();

function cookieOptions() {
  const secure = String(process.env.COOKIE_SECURE || "false").toLowerCase() === "true";
  const sameSite = process.env.COOKIE_SAMESITE || "lax"; // 'lax' | 'strict' | 'none'
  return {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: 24 * 60 * 60 * 1000
  };
}

router.post("/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ ok: false, error: "missing_fields" });

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
    return res.json({ ok: true, user: { id: payload.sub, email: payload.email, nome: payload.nome } });
  } catch {
    return res.json({ ok: true, user: null });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("token", cookieOptions());
  return res.json({ ok: true });
});

export default router;
