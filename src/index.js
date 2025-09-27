import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";

import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import registerRoutes from "./routes/register.js";
import empresasRoutes from "./routes/empresas.js";

/** =========================================
 *  CONFIG (pode vir de env no Railway)
 *  ========================================= */
const CONFIG = {
  JWT_SECRET: process.env.JWT_SECRET || "JWTprojetoINTEGRADOR2025",
  DATABASE_URL: process.env.DATABASE_URL || "mysql://root:rZJv0sIAPRpqtNtlYsgsiHQICPwVUasu@yamanbiko.proxy.rlwy.net:17978/railway",
  FRONTEND_ORIGINS:
    process.env.FRONTEND_ORIGINS ||
    "http://localhost:5173,https://projeto-frontend-gamma.vercel.app",
  NODE_ENV: process.env.NODE_ENV || "production",
};

// Injeta caso não esteja setado no ambiente
Object.assign(process.env, CONFIG);

console.log("🎯 CONFIGURAÇÃO INJETADA:");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅" : "❌");
console.log("DATABASE_URL:", process.env.DATABASE_URL ? "✅" : "❌");
console.log("FRONTEND_ORIGINS:", process.env.FRONTEND_ORIGINS);

/** =========================================
 *  APP
 *  ========================================= */
const app = express();

// 1) Necessário no Railway para cookies Secure + SameSite=None
app.set("trust proxy", 1);

// 2) Segurança base (CORP liberado para não bloquear assets externos)
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// 3) Body parser + cookies
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// 4) CORS (ANTES das rotas)
//    Usa whitelist da env FRONTEND_ORIGINS (CSV)
const allowed = process.env.FRONTEND_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // permite ferramentas sem 'Origin' (curl, Insomnia) e os domínios permitidos
      if (!origin || allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS bloqueado para origin: ${origin}`));
    },
    credentials: true, // necessário se o front usa fetch(..., { credentials: 'include' })
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Responde a preflight genericamente
app.options("*", cors());

// 5) Rate limit (exemplo: só em /api/auth)
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
});

/** =========================================
 *  ROTAS
 *  ========================================= */
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/registro", registerRoutes);
app.use("/api/empresas", empresasRoutes);

// Healthcheck
app.get("/health", (_, res) => {
  res.json({
    ok: true,
    message: "✅ Backend no ar",
    config: {
      jwt: process.env.JWT_SECRET ? "OK" : "FALHA",
      database: process.env.DATABASE_URL ? "OK" : "FALHA",
      origins: allowed,
      nodeEnv: process.env.NODE_ENV,
    },
  });
});

// Rota fallback (seu mock)
app.get("/api/dashboard/resumo", (req, res) => {
  res.json({
    ok: true,
    counts: { usuarios: 1, pessoas: 0, empresas: 0 },
  });
});

/** =========================================
 *  SERVER
 *  ========================================= */
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📊 Healthcheck: http://localhost:${port}/health`);
});
