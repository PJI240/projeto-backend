const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Ocorrencias = sequelize.define('Ocorrencias', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  funcionario_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  data: { type: DataTypes.DATEONLY, allowNull: false },
  tipo: { type: DataTypes.ENUM('FERIADO','ATESTADO','FALTA','FOLGA','OUTRO') },
  horas: { type: DataTypes.DECIMAL(10,2) },
  obs: { type: DataTypes.TEXT },
}, { tableName: 'ocorrencias', timestamps: false });

module.exports = Ocorrencias;
