const { home_routes, usuarios_routes } = require('./routes');
const { swaggerUi, swaggerSpec } = require('./config/swagger');

const express = require('express');
const app = express();
const port = 3000;

// middlewares
app.use(express.json());

// swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// routes
app.use('/', home_routes);
app.use('/usuarios', usuarios_routes);

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
