const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Escalas = sequelize.define('Escalas', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  funcionario_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  data: { type: DataTypes.DATEONLY, allowNull: false },
  turno_ordem: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  entrada: { type: DataTypes.TIME },
  saida: { type: DataTypes.TIME },
  origem: { type: DataTypes.ENUM('FIXA','EXCECAO') },
}, { tableName: 'escalas', timestamps: false });

module.exports = Escalas;
