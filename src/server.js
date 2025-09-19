const { home_routes } = require('./routes');

const express = require('express')();
const app = express();
const port = 3000;

// middlewares
app.use(express.json());

// routes
app.use('/', home_routes);

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${3000}`);
});
