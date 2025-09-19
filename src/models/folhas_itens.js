const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const FolhasItens = sequelize.define('FolhasItens', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  folha_funcionario_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  tipo: { type: DataTypes.ENUM('BASE','HE50','HE100','DESCONTO','PROVENTO','AJUSTE'), allowNull: false },
  referencia: { type: DataTypes.STRING(50) },
  quantidade: { type: DataTypes.DECIMAL(10,2), defaultValue: 0 },
  valor_unit: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
  valor_total: { type: DataTypes.DECIMAL(12,2), defaultValue: 0 },
}, { tableName: 'folhas_itens', timestamps: false });

module.exports = FolhasItens;
