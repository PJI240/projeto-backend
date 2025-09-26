import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRoutes from "./routes/auth.js";

dotenv.config();

const app = express();

// 1) Confia no proxy do Railway (necessário para cookie secure funcionar)
app.set("trust proxy", 1);

// 2) Segurança básica
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }, // evita bloquear assets se houver
}));

// 3) Body parser + cookies
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// 4) CORS com lista de origens do FRONTEND_ORIGINS (separadas por vírgula)
const origins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                 // permite curl/postman
    if (origins.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
};

// aplica CORS e trata preflight
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // responde OPTIONS 204

// 5) Rate limit só nas rotas de auth (anti brute-force)
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 min
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// 6) Rotas
app.use("/api/auth", authLimiter, authRoutes);

// Healthcheck
app.get("/health", (_, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

// 7) Tratamento de erros (inclui erros de CORS)
app.use((err, _req, res, _next) => {
  if (err?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ ok: false, error: "cors_denied" });
  }
  console.error("UNHANDLED_ERROR:", err);
  return res.status(500).json({ ok: false, error: "server_error" });
});

// 8) Sobe servidor
const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API ouvindo em http://localhost:${port}`));
