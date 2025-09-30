// routes/auth.js
import { Router } from "express";
import { pool } from "../db.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit"; // ← ADD

const router = Router();

/* ===================== Helpers de RBAC ===================== */

function normalizeRoleName(s = "") {
  return String(s).trim().toLowerCase();
}

function decideLanding(roles = []) {
  const r = roles.map(normalizeRoleName);
  if (r.includes("desenvolvedor")) return "/dashboard";      // visão total
  if (r.includes("administrador")) return "/dashboard_adm";  // admin da(s) empresa(s)
  if (r.includes("funcionario"))   return "/dashboard_func"; // painel do funcionário
  return "/dashboard"; // fallback
}

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `
      SELECT p.nome AS perfil_nome
      FROM usuarios_perfis up
      JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?
    `,
    [userId]
  );
  return rows.map((r) => r.perfil_nome);
}

/* ===================== Cookies ===================== */

function cookieOptionsBase() {
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

  // SameSite=None exige Secure=true
  if (sameSite === "none" && !secure) secure = true;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: "/",
  };
}

function cookieSetOptions() {
  return {
    ...cookieOptionsBase(),
    maxAge: 24 * 60 * 60 * 1000, // 1 dia
  };
}

function cookieClearOptions() {
  // sem maxAge (Express 5 expira automaticamente)
  return {
    ...cookieOptionsBase(),
  };
}

/* ===================== Rate limit SOMENTE no /login ===================== */

const loginLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20,             // até 20 tentativas por minuto
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.headers["x-forwarded-for"] || "ip";
    const email = String(req.body?.email || "").toLowerCase();
    return `${ip}:${email}`;
  },
});

/* ===================== /register ===================== */

router.post("/register", async (req, res) => {
  try {
    let { nome, email, senha } = req.body || {};
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    nome = String(nome).trim();
    email = String(email).trim().toLowerCase();
    senha = String(senha);

    const [existingUsers] = await pool.query(
      `SELECT id FROM usuarios WHERE LOWER(email) = ? LIMIT 1`,
      [email]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ ok: false, error: "email_already_exists" });
    }

    const hashedPassword = await bcrypt.hash(senha, 12);
    const [result] = await pool.query(
      `INSERT INTO usuarios (nome, email, senha) VALUES (?,?,?)`,
      [nome, email, hashedPassword]
    );

    const token = jwt.sign(
      { sub: result.insertId, email, nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieSetOptions());

    const roles = await getUserRoles(result.insertId);
    const landing = decideLanding(roles);

    return res.json({
      ok: true,
      user: { id: result.insertId, email, nome },
      roles,
      landing,
    });
  } catch (e) {
    console.error("REGISTER_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ===================== /login (com limiter) ===================== */

router.post("/login", loginLimiter, async (req, res) => {
  try {
    let { email, senha } = req.body || {};
    if (!email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

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

    if (!user || user.ativo !== 1) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const passwordOK = await bcrypt.compare(senha, user.senhaDb);
    if (!passwordOK) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieSetOptions());

    const roles = await getUserRoles(user.id);
    const landing = decideLanding(roles);

    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, nome: user.nome },
      roles,
      landing,
    });
  } catch (e) {
    console.error("LOGIN_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ===================== /me ===================== */

router.get("/me", async (req, res) => {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.json({ ok: true, user: null });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.json({ ok: true, user: null });
    }

    const [[u]] = await pool.query(
      `SELECT id, nome, email, ativo FROM usuarios WHERE id = ? LIMIT 1`,
      [payload.sub]
    );
    if (!u || u.ativo !== 1) {
      return res.json({ ok: true, user: null });
    }

    const roles = await getUserRoles(u.id);
    const landing = decideLanding(roles);

    return res.json({
      ok: true,
      user: { id: u.id, email: u.email, nome: u.nome },
      roles,
      landing,
    });
  } catch (_e) {
    return res.json({ ok: true, user: null });
  }
});

/* ===================== /logout ===================== */

router.post("/logout", (req, res) => {
  // Express 5: não passe maxAge no clearCookie
  res.clearCookie("token", cookieClearOptions());
  return res.json({ ok: true });
});

export default router;
