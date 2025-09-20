const { Usuarios } = require('../models/usuarios');

/**
 * @openapi
 * /usuarios:
 *   get:
 *     tags:
 *       - Usuarios
 *     summary: Lista todos os usuários
 *     responses:
 *       '200':
 *         description: Lista de usuários
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Usuario'
 *       '500':
 *         description: Erro interno
 */
const list = async (req, res) => {
  try {
    const usuarios = await Usuarios.findAll();
    res.json(usuarios);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * @openapi
 * /usuarios:
 *   post:
 *     tags:
 *       - Usuarios
 *     summary: Cria um novo usuário
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UsuarioInput'
 *     responses:
 *       '201':
 *         description: Usuário criado
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Usuario'
 *       '400':
 *         description: Requisição inválida
 *       '409':
 *         description: Email já cadastrado
 *       '500':
 *         description: Erro interno
 */
const create = async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: 'nome, email e senha são obrigatórios' });

    const exists = await Usuarios.findOne({ where: { email } });
    if (exists) return res.status(409).json({ error: 'Email já cadastrado' });

    const usuario = await Usuarios.create({ nome, email, senha });
    res.status(201).json(usuario);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  UsuariosController: {
    list,
    create
  }
}
