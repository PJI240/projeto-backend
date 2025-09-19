const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FolhasFuncionarios = sequelize.define('FolhasFuncionarios', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  folha_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  funcionario_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  horas_normais: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  he50_horas: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  he100_horas: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  valor_base: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  valor_he50: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  valor_he100: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  descontos: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  proventos: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  total_liquido: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  inconsistencias: { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'folhas_funcionarios', timestamps: false });

module.exports = FolhasFuncionarios;
