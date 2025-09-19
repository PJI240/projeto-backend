const { Router } = require('express');
const { homeController } = require('./controllers/home.controller');

const home_routes = Router();

home_routes.get('/', homeController)

exports.home_routes;
