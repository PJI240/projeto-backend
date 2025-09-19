const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Usuarios = sequelize.define('Usuarios', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  nome: { type: DataTypes.STRING(255) },
  email: { type: DataTypes.STRING(255), unique: true },
}, { tableName: 'usuarios', timestamps: false });

module.exports = Usuarios;
