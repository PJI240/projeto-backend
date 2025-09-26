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
// Ex.: FRONTEND_ORIGINS=http://localhost:5173,https://projeto-frontend-gamma.vercel.app
const origins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(s => s.trim().replace(/\/$/, "")) // remove barra final
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/postman

    try {
      const clean = origin.replace(/\/$/, "");
      const hostname = new URL(clean).hostname;

      // aceita exatas da env OU qualquer preview do Vercel (*.vercel.app)
      const allowPreviewVercel = hostname.endsWith(".vercel.app");

      if (origins.includes(clean) || allowPreviewVercel) {
        return cb(null, true);
      }
    } catch (_) {}

    return cb(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 600, // cache do preflight (10 min)
};

// aplica CORS e responde preflight
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));// 5) Rate limit só nas rotas de auth (anti brute-force)
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
