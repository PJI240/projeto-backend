const { Router } = require('express');
const { HomeController } = require('./controllers/home.controller');
const { UsuariosController } = require('./controllers/usuarios.controller');
const { pool } = require('./db'); // importa a conexão MySQL

const home_routes = Router();
const usuarios_routes = Router();
const health_routes = Router(); // <<< novo

// HOME
home_routes.get('/', HomeController.show);

// USUARIOS
usuarios_routes.get('/', UsuariosController.list);
usuarios_routes.post('/', UsuariosController.create);

// HEALTH (teste de conexão com o banco)
health_routes.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    return res.json({ ok: rows[0].ok === 1 });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = { home_routes, usuarios_routes, health_routes };
