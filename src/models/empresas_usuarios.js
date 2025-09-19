const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const EmpresasUsuarios = sequelize.define('EmpresasUsuarios', {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  empresa_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  usuario_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  perfil_principal: { type: DataTypes.STRING(100) },
  ativo: { type: DataTypes.BOOLEAN, defaultValue: true },
}, { tableName: 'empresas_usuarios', timestamps: false });

module.exports = EmpresasUsuarios;
