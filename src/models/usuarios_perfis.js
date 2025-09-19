const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const UsuariosPerfis = sequelize.define('UsuariosPerfis', {
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  usuario_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
  perfil_id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
}, { tableName: 'usuarios_perfis', timestamps: false });

module.exports = UsuariosPerfis;
