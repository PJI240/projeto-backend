const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Funcionarios = sequelize.define('Funcionarios', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  pessoa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  cargo_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  regime: { type: DataTypes.ENUM('HORISTA','DIARISTA','MENSALISTA') },
  salario_base: { type: DataTypes.DECIMAL(10,2), defaultValue: 3029.00 },
  valor_hora: { type: DataTypes.DECIMAL(10,2) },
  ativo: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'funcionarios', timestamps: false });

module.exports = Funcionarios;
