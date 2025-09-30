// src/index.js
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import registerRoutes from "./routes/register.js";
import empresasRoutes from "./routes/empresas.js";
import pessoasRoutes from "./routes/pessoas.js";
import cargosRoutes from "./routes/cargos.js";
import funcionariosRoutes from "./routes/funcionarios.js";
import usuariosRoutes from "./routes/usuarios.js";
import perfisRoutes from "./routes/perfis.js";
import permissoesRoutes from "./routes/permissoes.js";

const CONFIG = {
  JWT_SECRET: process.env.JWT_SECRET || "JWTprojetoINTEGRADOR2025",
  DATABASE_URL:
    process.env.DATABASE_URL ||
    "mysql://root:rZJv0sIAPRpqtNtlYsgsiHQICPwVUasu@yamanbiko.proxy.rlwy.net:17978/railway",
  FRONTEND_ORIGINS:
    process.env.FRONTEND_ORIGINS ||
    "http://localhost:5173,https://projeto-frontend-gamma.vercel.app",
  NODE_ENV: process.env.NODE_ENV || "production",
};

// Injeta no environment se faltar
Object.assign(process.env, CONFIG);

console.log("🎯 CONFIGURAÇÃO INJETADA:");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅" : "❌");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "✅" : "❌");
console.log("FRONTEND_ORIGINS:", process.env.FRONTEND_ORIGINS);
console.log("NODE_ENV:", process.env.NODE_ENV);

/** =========================================
 *  APP
 *  ========================================= */
const app = express();

// 1) Necessário no Railway p/ cookies Secure + SameSite=None
app.set("trust proxy", 1);

// 2) Segurança base
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// 3) CORS (ANTES de parsers/rotas)
const allowList = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const d of [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://projeto-frontend-gamma.vercel.app",
]) {
  if (!allowList.includes(d)) allowList.push(d);
}

const vercelPreviewRe = /\.vercel\.app$/i;

const corsOptions = {
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  origin(origin, cb) {
    try {
      if (!origin) return cb(null, true); // curl / same-origin
      const ok =
        allowList.includes(origin) || vercelPreviewRe.test(origin);
      if (ok) return cb(null, true);
      return cb(new Error(`CORS: origin não permitido -> ${origin}`));
    } catch {
      return cb(new Error("CORS: erro ao validar origin"));
    }
  },
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// 4) Parsers
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

/** =========================================
 *  ROTAS
 *  ========================================= */
app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/registro", registerRoutes);
app.use("/api/empresas", empresasRoutes);
app.use("/api/pessoas", pessoasRoutes);
app.use("/api/cargos", cargosRoutes);
app.use("/api/funcionarios", funcionariosRoutes);
app.use("/api/usuarios", usuariosRoutes);
app.use("/api/perfis", perfisRoutes);
app.use("/api/permissoes", permissoesRoutes);

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "✅ Backend no ar",
    config: {
      jwt: process.env.JWT_SECRET ? "OK" : "FALHA",
      database: process.env.DATABASE_URL ? "OK" : "FALHA",
      origins: allowList,
      nodeEnv: process.env.NODE_ENV,
    },
  });
});

// Mock de resumo (fallback)
app.get("/api/dashboard/resumo", (_req, res) => {
  res.json({
    ok: true,
    counts: { usuarios: 1, pessoas: 0, empresas: 0 },
  });
});

/** =========================================
 *  HANDLER GLOBAL DE ERROS
 *  ========================================= */
app.use((err, _req, res, _next) => {
  const msg = String(err?.message || "");
  if (msg.startsWith("CORS")) {
    return res.status(403).json({ ok: false, error: msg });
  }
  console.error("UNHANDLED_ERROR", err);
  return res.status(500).json({ ok: false, error: "internal_error" });
});

/** =========================================
 *  SERVER
 *  ========================================= */
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📊 Healthcheck: http://localhost:${port}/health`);
});
