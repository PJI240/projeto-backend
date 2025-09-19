const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Folhas = sequelize.define('Folhas', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  competencia: { type: DataTypes.STRING(7), allowNull: false },
  status: { type: DataTypes.ENUM('ABERTA','FECHADA','PAGA'), allowNull: false },
  criado_em: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, { tableName: 'folhas', timestamps: false });

module.exports = Folhas;
