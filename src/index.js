import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRoutes from "./routes/auth.js";

dotenv.config();

const app = express();

app.use(helmet());
app.use(express.json());
app.use(cookieParser());

// CORS: libera origens definidas na var FRONTEND_ORIGINS (separadas por vírgula)
const origins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                 // permite curl/postman
    if (origins.includes(origin)) return cb(null, true);
    return cb(new Error("Origin not allowed by CORS"));
  },
  credentials: true
}));

// rate limit só nas rotas de auth
const authLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 30 });
app.use("/api/auth", authLimiter, authRoutes);

// healthcheck
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API ouvindo em http://localhost:${port}`));
