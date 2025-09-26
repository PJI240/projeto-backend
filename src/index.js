import express from "express";
// REMOVA dotenv - não é necessário no Railway
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import authRoutes from "./routes/auth.js";

// REMOVA esta linha: dotenv.config();

const app = express();

// Debug: Verifique se as variáveis estão carregadas
console.log('=== VARIÁVEIS DE AMBIENTE ===');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('JWT_SECRET existe?', !!process.env.JWT_SECRET);
console.log('DATABASE_URL existe?', !!process.env.DATABASE_URL);
console.log('FRONTEND_ORIGINS:', process.env.FRONTEND_ORIGINS);

// 1) Confia no proxy do Railway (necessário para cookie secure funcionar)
app.set("trust proxy", 1);

// 2) Segurança básica
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// 3) Body parser + cookies
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// 4) CORS - versão simplificada para debug
const corsOptions = {
  origin: function (origin, callback) {
    // Em produção, aceita todas as origens temporariamente para testar
    if (process.env.NODE_ENV === 'production') {
      return callback(null, true);
    }
    
    // Desenvolvimento local: checagem normal
    const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
};

app.use(cors(corsOptions));

// 5) Rate limit
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// 6) Rotas
app.use("/api/auth", authLimiter, authRoutes);

// Healthcheck melhorado
app.get("/health", (_, res) => {
  res.json({ 
    ok: true, 
    ts: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    variables: {
      hasJwtSecret: !!process.env.JWT_SECRET,
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      frontendOrigins: process.env.FRONTEND_ORIGINS
    }
  });
});

// 7) Tratamento de erros
app.use((err, _req, res, _next) => {
  console.error("ERRO:", err);
  return res.status(500).json({ ok: false, error: "server_error" });
});

// 8) Sobe servidor
const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`=== SERVIDOR INICIADO ===`);
  console.log(`Porta: ${port}`);
  console.log(`Ambiente: ${process.env.NODE_ENV}`);
  console.log(`JWT Secret: ${process.env.JWT_SECRET ? 'CONFIGURADO' : 'NÃO CONFIGURADO'}`);
  console.log(`Database URL: ${process.env.DATABASE_URL ? 'CONFIGURADA' : 'NÃO CONFIGURADA'}`);
});
