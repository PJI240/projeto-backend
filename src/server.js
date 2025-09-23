// /backend/src/server.js
require('dotenv').config(); 

const { home_routes, usuarios_routes } = require('./routes');
const { swaggerUi, swaggerSpec } = require('./config/swagger');

const express = require('express');
const health_routes = require('./routes/health'); 
const app = express();

// middlewares
app.use(express.json());

// swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// routes
app.use('/', home_routes);
app.use('/usuarios', usuarios_routes);
app.use('/health', health_routes); 

const port = process.env.PORT || 3000; 
app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
