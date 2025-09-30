// cada permissão representa uma “capacidade”/rota/menu
export const PERMISSIONS_REGISTRY = [
  { codigo: "menu.dashboard.ver", descricao: "Ver Dashboard", escopo: "ui" },
  { codigo: "menu.usuarios.ver", descricao: "Ver Usuários", escopo: "ui" },
  { codigo: "usuarios.criar", descricao: "Criar usuário", escopo: "api" },
  { codigo: "usuarios.editar", descricao: "Editar usuário", escopo: "api" },
  { codigo: "usuarios.excluir", descricao: "Excluir usuário", escopo: "api" },
];
