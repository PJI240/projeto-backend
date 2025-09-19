const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Permissoes = sequelize.define('Permissoes', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  codigo: { type: DataTypes.STRING(100), allowNull: false, unique: true },
}, { tableName: 'permissoes', timestamps: false });

module.exports = Permissoes;
