import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRoutes from "./routes/auth.js";


const CONFIG = {
  JWT_SECRET: "JWTprojetoINTEGRADOR2025",
  DATABASE_URL: "mysql://root:rZJv0sIAPRpqtNtlYsgsiHQICPwVUasu@yamanbiko.proxy.rlwy.net:17978/railway",
  FRONTEND_ORIGINS: "http://localhost:5173,https://projeto-frontend-gamma.vercel.app",
  NODE_ENV: "production"
};

// Injeta no process.env
Object.assign(process.env, CONFIG);

console.log('🎯 CONFIGURAÇÃO INJETADA:');
console.log('JWT_SECRET:', process.env.JWT_SECRET ? '✅' : '❌');
console.log('DATABASE_URL:', process.env.DATABASE_URL ? '✅' : '❌');

const app = express();
app.set("trust proxy", 1);

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// CORS simplificado
app.use(cors({
  origin: true, // Aceita todas temporariamente
  credentials: true
}));

// Rate limit
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
});

app.use("/api/auth", authLimiter, authRoutes);

// Healthcheck
app.get("/health", (_, res) => {
  res.json({ 
    ok: true,
    message: "✅ Backend funcionando com variáveis fixas",
    config: {
      jwt: process.env.JWT_SECRET ? "OK" : "FALHA",
      database: process.env.DATABASE_URL ? "OK" : "FALHA"
    }
  });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
  console.log(`📊 Healthcheck: http://localhost:${port}/health`);
});
