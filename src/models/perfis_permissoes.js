const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PerfisPermissoes = sequelize.define('PerfisPermissoes', {
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  perfil_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  permissao_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: 'perfis_permissoes', timestamps: false });

module.exports = PerfisPermissoes;
