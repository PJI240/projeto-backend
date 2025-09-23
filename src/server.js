// /backend/src/server.js
require('dotenv').config(); // <<< carrega .env (local) e permite PORT no Railway

const { home_routes, usuarios_routes } = require('./routes');
const { swaggerUi, swaggerSpec } = require('./config/swagger');

const express = require('express');
const health_routes = require('./routes/health'); // <<< rota nova de health
const app = express();

// middlewares
app.use(express.json());

// swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// routes
app.use('/', home_routes);
app.use('/usuarios', usuarios_routes);
app.use('/health', health_routes); // <<< GET /health

const port = process.env.PORT || 3000; // <<< usa a porta do Railway quando em produção
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
