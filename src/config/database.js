const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('projeto_db', 'user', 'userpassword', {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  dialect: 'mysql',
});

module.exports = sequelize;
