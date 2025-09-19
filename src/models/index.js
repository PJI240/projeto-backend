const sequelize = require('../config/database');

const Empresas = require('./empresas');
const EmpresasUsuarios = require('./empresas_usuarios');
const Perfis = require('./perfis');
const Permissoes = require('./permissoes');
const PerfisPermissoes = require('./perfis_permissoes');
const UsuariosPerfis = require('./usuarios_perfis');
const Usuarios = require('./usuarios');
const Cargos = require('./cargos');
const Funcionarios = require('./funcionarios');
const Escalas = require('./escalas');
const Apontamentos = require('./apontamentos');
const Ocorrencias = require('./ocorrencias');
const Folhas = require('./folhas');
const FolhasFuncionarios = require('./folhas_funcionarios');
const FolhasItens = require('./folhas_itens');

// Associations
Empresas.hasMany(EmpresasUsuarios, { foreignKey: 'empresa_id' });
EmpresasUsuarios.belongsTo(Empresas, { foreignKey: 'empresa_id' });

Empresas.hasMany(Perfis, { foreignKey: 'empresa_id' });
Perfis.belongsTo(Empresas, { foreignKey: 'empresa_id' });

Perfis.belongsToMany(Permissoes, { through: PerfisPermissoes, foreignKey: 'perfil_id', otherKey: 'permissao_id' });
Permissoes.belongsToMany(Perfis, { through: PerfisPermissoes, foreignKey: 'permissao_id', otherKey: 'perfil_id' });

// UsuariosPerfis (junction) - many-to-many between usuarios and perfis per empresa
Perfis.belongsToMany(Usuarios, { through: UsuariosPerfis, foreignKey: 'perfil_id', otherKey: 'usuario_id' });
Usuarios.belongsToMany(Perfis, { through: UsuariosPerfis, foreignKey: 'usuario_id', otherKey: 'perfil_id' });

Empresas.hasMany(Cargos, { foreignKey: 'empresa_id' });
Cargos.belongsTo(Empresas, { foreignKey: 'empresa_id' });

Empresas.hasMany(Funcionarios, { foreignKey: 'empresa_id' });
Funcionarios.belongsTo(Empresas, { foreignKey: 'empresa_id' });

Cargos.hasMany(Funcionarios, { foreignKey: 'cargo_id' });
Funcionarios.belongsTo(Cargos, { foreignKey: 'cargo_id' });

// Funcionarios -> Escalas / Apontamentos / Ocorrencias
Funcionarios.hasMany(Escalas, { foreignKey: 'funcionario_id' });
Escalas.belongsTo(Funcionarios, { foreignKey: 'funcionario_id' });

Funcionarios.hasMany(Apontamentos, { foreignKey: 'funcionario_id' });
Apontamentos.belongsTo(Funcionarios, { foreignKey: 'funcionario_id' });

Funcionarios.hasMany(Ocorrencias, { foreignKey: 'funcionario_id' });
Ocorrencias.belongsTo(Funcionarios, { foreignKey: 'funcionario_id' });

// Folhas associations
Empresas.hasMany(Folhas, { foreignKey: 'empresa_id' });
Folhas.belongsTo(Empresas, { foreignKey: 'empresa_id' });

Folhas.hasMany(FolhasFuncionarios, { foreignKey: 'folha_id' });
FolhasFuncionarios.belongsTo(Folhas, { foreignKey: 'folha_id' });

Funcionarios.hasMany(FolhasFuncionarios, { foreignKey: 'funcionario_id' });
FolhasFuncionarios.belongsTo(Funcionarios, { foreignKey: 'funcionario_id' });

FolhasFuncionarios.hasMany(FolhasItens, { foreignKey: 'folha_funcionario_id' });
FolhasItens.belongsTo(FolhasFuncionarios, { foreignKey: 'folha_funcionario_id' });

module.exports = {
  sequelize,
  Empresas,
  EmpresasUsuarios,
  Perfis,
  Permissoes,
  PerfisPermissoes,
  UsuariosPerfis,
  Cargos,
  Funcionarios,
  Escalas,
  Apontamentos,
  Ocorrencias,
  Folhas,
  FolhasFuncionarios,
  FolhasItens,
};
