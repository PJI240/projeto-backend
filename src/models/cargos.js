const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Cargos = sequelize.define('Cargos', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  nome: { type: DataTypes.STRING(100), allowNull: false },
  descricao: { type: DataTypes.TEXT },
  ativo: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'cargos', timestamps: false });

module.exports = Cargos;
