const sequelize = require("../config/database");
const { DataTypes } = require("sequelize");

const Usuarios = sequelize.define('usuarios', {
  nome: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, allowNull: false, unique: true },
  senha: { type: DataTypes.STRING, allowNull: false },
  ativo: { type: DataTypes.BOOLEAN, defaultValue: true },
  criado_em: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  atualizado_em: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
  tableName: "usuarios",
  timestamps: false, // Desativa createdAt/updatedAt automáticos
});

module.exports = { Usuarios };
