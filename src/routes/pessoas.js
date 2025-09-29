// src/routes/pessoas.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ========= helpers ========= */

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");

  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0]; // default
}

function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

async function ensureDefaultCargo(conn, empresaId) {
  const NOME = "Colaborador";
  const [[row]] = await conn.query(
    `SELECT id FROM cargos WHERE empresa_id = ? AND nome = ? LIMIT 1`,
    [empresaId, NOME]
  );
  if (row?.id) return row.id;

  const [ins] = await conn.query(
    `INSERT INTO cargos (empresa_id, nome, descricao, ativo) VALUES (?,?,?,1)`,
    [empresaId, NOME, "Cargo padrão gerado automaticamente"]
  );
  return ins.insertId;
}

/* ========= rotas ========= */

/**
 * GET /api/pessoas?empresa_id=OPC
 * Lista pessoas vinculadas à empresa (via funcionarios).
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    const [rows] = await pool.query(
      `
      SELECT p.id, p.nome, p.cpf, p.data_nascimento, p.telefone, p.email,
             f.id AS funcionario_id, f.cargo_id, f.regime, f.ativo AS funcionario_ativo
        FROM pessoas p
        JOIN funcionarios f ON f.pessoa_id = p.id
       WHERE f.empresa_id = ?
       ORDER BY p.nome ASC
      `,
      [empresaId]
    );

    return res.json({ ok: true, empresa_id: empresaId, pessoas: rows });
  } catch (e) {
    console.error("PESSOAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar pessoas." });
  }
});

/**
 * GET /api/pessoas/:id?empresa_id=OPC
 * Detalhe da pessoa (verifica vínculo via funcionarios).
 */
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    const [[row]] = await pool.query(
      `
      SELECT p.*
        FROM pessoas p
        JOIN funcionarios f ON f.pessoa_id = p.id
       WHERE p.id = ? AND f.empresa_id = ?
       LIMIT 1
      `,
      [id, empresaId]
    );

    if (!row) return res.status(404).json({ ok: false, error: "Pessoa não encontrada." });
    return res.json({ ok: true, empresa_id: empresaId, pessoa: row });
  } catch (e) {
    console.error("PESSOA_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao obter pessoa." });
  }
});

/**
 * POST /api/pessoas
 * Body: { nome, cpf, data_nascimento, telefone, email, cargo_id?, regime? }
 * Cria a pessoa e JÁ vincula à empresa do usuário em `funcionarios`.
 */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    const {
      nome,
      cpf = "",
      data_nascimento = null,
      telefone = null,
      email = null,
      cargo_id = null,
      regime = "MENSALISTA", // HORISTA | DIARISTA | MENSALISTA
      salario_base = null,    // opcional
      valor_hora = null,      // opcional
    } = req.body || {};

    if (!String(nome || "").trim()) {
      return res.status(400).json({ ok: false, error: "Nome é obrigatório." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) cria pessoa
    const [insP] = await conn.query(
      `INSERT INTO pessoas (nome, cpf, data_nascimento, telefone, email)
       VALUES (?,?,?,?,?)`,
      [nome, cpf || null, data_nascimento || null, telefone, email]
    );
    const pessoaId = insP.insertId;

    // 2) garante cargo
    let cargoId = cargo_id;
    if (!cargoId) {
      cargoId = await ensureDefaultCargo(conn, empresaId);
    } else {
      // valida cargo informado pertence à empresa
      const [[cOk]] = await conn.query(
        `SELECT id FROM cargos WHERE id = ? AND empresa_id = ? LIMIT 1`,
        [cargoId, empresaId]
      );
      if (!cOk) {
        // se inválido, cai para o default
        cargoId = await ensureDefaultCargo(conn, empresaId);
      }
    }

    // 3) cria vínculo em funcionarios
    await conn.query(
      `INSERT INTO funcionarios
         (empresa_id, pessoa_id, cargo_id, regime, salario_base, valor_hora, ativo)
       VALUES (?,?,?,?,?,?,1)`,
      [
        empresaId,
        pessoaId,
        cargoId,
        ["HORISTA", "DIARISTA", "MENSALISTA"].includes(String(regime).toUpperCase())
          ? String(regime).toUpperCase()
          : "MENSALISTA",
        salario_base ?? null,
        valor_hora ?? null,
      ]
    );

    await conn.commit();

    return res.json({ ok: true, id: pessoaId, empresa_id: empresaId, cargo_id: cargoId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("PESSOA_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar pessoa." });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * PUT /api/pessoas/:id
 * Atualiza campos de pessoas (somente se vinculada à empresa).
 */
router.put("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // Verifica se pertence à empresa
    const [[okRow]] = await pool.query(
      `SELECT 1 FROM funcionarios WHERE empresa_id = ? AND pessoa_id = ? LIMIT 1`,
      [empresaId, id]
    );
    if (!okRow) return res.status(404).json({ ok: false, error: "Pessoa não encontrada na empresa." });

    const { nome, cpf, data_nascimento, telefone, email } = req.body || {};
    await pool.query(
      `UPDATE pessoas
          SET nome = ?, cpf = ?, data_nascimento = ?, telefone = ?, email = ?
        WHERE id = ?`,
      [nome || null, cpf || null, data_nascimento || null, telefone || null, email || null, id]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("PESSOA_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar pessoa." });
  }
});

/**
 * DELETE /api/pessoas/:id
 * Remove pessoa (cascateia para funcionarios por FK ON DELETE CASCADE).
 */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // Garante vínculo
    const [[okRow]] = await pool.query(
      `SELECT 1 FROM funcionarios WHERE empresa_id = ? AND pessoa_id = ? LIMIT 1`,
      [empresaId, id]
    );
    if (!okRow) return res.status(404).json({ ok: false, error: "Pessoa não encontrada na empresa." });

    await pool.query(`DELETE FROM pessoas WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    console.error("PESSOA_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir pessoa." });
  }
});

export default router;