const { Router } = require('express');
const { HomeController } = require('./controllers/home.controller');
const { UsuariosController } = require('./controllers/usuarios.controller');

const home_routes = Router();
const usuarios_routes = Router();

// HOME
home_routes.get('/', HomeController.show);

// USUARIOS
usuarios_routes.get('/', UsuariosController.list);
usuarios_routes.post('/', UsuariosController.create);

module.exports = { home_routes, usuarios_routes };
