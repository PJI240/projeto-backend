import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRoutes from "./routes/auth.js";

dotenv.config();

const app = express();

// Segurança básica
app.use(helmet());

// Parse de JSON + cookies
app.use(express.json());
app.use(cookieParser());

// CORS — libera só o seu front
app.use(cors({
  origin: process.env.FRONTEND_ORIGIN,
  credentials: true
}));

// Rate limit nas rotas de auth
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 30
});
app.use("/api/auth", authLimiter);

// Rotas
app.use("/api/auth", authRoutes);

// Health check
app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`API ouvindo em http://localhost:${port}`);
});
