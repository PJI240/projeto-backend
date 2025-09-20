const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('empresa_db', 'user', 'userpassword', {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  dialect: 'mysql',
  logging: false
});

module.exports = sequelize;
