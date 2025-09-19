const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Empresas = sequelize.define('Empresas', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  razao_social: { type: DataTypes.STRING(255), allowNull: false },
  nome_fantasia: { type: DataTypes.STRING(255) },
  cnpj: { type: DataTypes.STRING(20), allowNull: false, unique: true },
  inscricao_estadual: { type: DataTypes.STRING(50) },
  data_abertura: { type: DataTypes.DATEONLY },
  telefone: { type: DataTypes.STRING(20) },
  email: { type: DataTypes.STRING(255) },
  capital_social: { type: DataTypes.DECIMAL(18,2) },
  natureza_juridica: { type: DataTypes.STRING(100) },
  situacao_cadastral: { type: DataTypes.STRING(50) },
  data_situacao: { type: DataTypes.DATEONLY },
  socios_receita: { type: DataTypes.JSON },
  ativa: { type: DataTypes.BOOLEAN, defaultValue: true },
  criado_em: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  atualizado_em: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName: 'empresas',
  timestamps: false,
});

module.exports = Empresas;
