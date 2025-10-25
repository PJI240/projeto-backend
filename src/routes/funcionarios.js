// src/routes/funcionarios.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ========= helpers ========= */
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

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

/** Resolve empresa corrente (verifica vínculo) */
async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");

  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
}

/** Normaliza regime */
function normRegime(v) {
  const R = String(v || "MENSALISTA").toUpperCase();
  return ["HORISTA", "DIARISTA", "MENSALISTA"].includes(R) ? R : "MENSALISTA";
}

/** Recalcula salário_base / valor_hora coerentemente */
function computeValores(regime, salario_base, valor_hora) {
  let base = salario_base == null ? null : Number(salario_base);
  let hora = valor_hora == null ? null : Number(valor_hora);

  if (isNaN(base)) base = null;
  if (isNaN(hora)) hora = null;

  // Regras de coerência
  switch (normRegime(regime)) {
    case "MENSALISTA":
      if (base && !hora) hora = base / 220;
      if (hora && !base) base = hora * 220;
      break;
    case "HORISTA":
      if (!hora && base) hora = base; // hora = base (interpreta salário_base = valor/hora)
      if (!base && hora) base = hora * 220; // salário base estimado
      break;
    case "DIARISTA":
      // Considera 8h por dia, 22 dias por mês
      if (base && !hora) hora = base / (22 * 8);
      if (hora && !base) base = hora * 22 * 8;
      break;
  }

  return {
    salario_base: base ? Number(base.toFixed(2)) : null,
    valor_hora: hora ? Number(hora.toFixed(4)) : null,
  };
}

/* ========= rotas ========= */

/** GET /api/funcionarios?empresa_id= */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    const [rows] = await pool.query(
      `
      SELECT f.id, f.empresa_id, f.pessoa_id, f.cargo_id, f.regime,
             f.salario_base, f.valor_hora, f.ativo,
             p.nome AS pessoa_nome,
             c.nome AS cargo_nome
        FROM funcionarios f
        JOIN pessoas p ON p.id = f.pessoa_id
        JOIN cargos c  ON c.id = f.cargo_id
       WHERE f.empresa_id = ?
       ORDER BY p.nome ASC
      `,
      [empresaId]
    );

    return res.json({ ok: true, empresa_id: empresaId, funcionarios: rows });
  } catch (e) {
    console.error("FUNC_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar funcionários." });
  }
});

/** POST /api/funcionarios */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const {
      pessoa_id,
      cargo_id,
      regime = "MENSALISTA",
      salario_base = null,
      valor_hora = null,
      ativo = 1,
    } = req.body || {};

    if (!pessoa_id || !cargo_id) {
      return res.status(400).json({ ok: false, error: "Pessoa e Cargo são obrigatórios." });
    }

    const { salario_base: baseFinal, valor_hora: horaFinal } = computeValores(
      regime,
      salario_base,
      valor_hora
    );

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[pOk]] = await conn.query(`SELECT id FROM pessoas WHERE id = ? LIMIT 1`, [pessoa_id]);
    if (!pOk) throw new Error("Pessoa inexistente.");

    const [[cOk]] = await conn.query(
      `SELECT id FROM cargos WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [cargo_id, empresaId]
    );
    if (!cOk) throw new Error("Cargo não pertence à empresa.");

    await conn.query(
      `
      INSERT INTO funcionarios
        (empresa_id, pessoa_id, cargo_id, regime, salario_base, valor_hora, ativo)
      VALUES (?,?,?,?,?,?,?)
      `,
      [
        empresaId,
        Number(pessoa_id),
        Number(cargo_id),
        normRegime(regime),
        baseFinal,
        horaFinal,
        ativo ? 1 : 0,
      ]
    );

    await conn.commit();
    return res.json({ ok: true, salario_base: baseFinal, valor_hora: horaFinal });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Esta pessoa já está vinculada à empresa." });
    }
    console.error("FUNC_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar funcionário." });
  } finally {
    if (conn) conn.release();
  }
});

/** PUT /api/funcionarios/:id */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    const {
      cargo_id,
      regime = "MENSALISTA",
      salario_base = null,
      valor_hora = null,
      ativo = 1,
    } = req.body || {};

    const { salario_base: baseFinal, valor_hora: horaFinal } = computeValores(
      regime,
      salario_base,
      valor_hora
    );

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[fOk]] = await conn.query(
      `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [id, empresaId]
    );
    if (!fOk) throw new Error("Funcionário não encontrado na empresa.");

    if (cargo_id) {
      const [[cOk]] = await conn.query(
        `SELECT id FROM cargos WHERE id = ? AND empresa_id = ? LIMIT 1`,
        [cargo_id, empresaId]
      );
      if (!cOk) throw new Error("Cargo não pertence à empresa.");
    }

    await conn.query(
      `
      UPDATE funcionarios
         SET cargo_id = COALESCE(?, cargo_id),
             regime = ?,
             salario_base = ?,
             valor_hora = ?,
             ativo = ?
       WHERE id = ?
      `,
      [
        cargo_id ? Number(cargo_id) : null,
        normRegime(regime),
        baseFinal,
        horaFinal,
        ativo ? 1 : 0,
        id,
      ]
    );

    await conn.commit();
    return res.json({ ok: true, salario_base: baseFinal, valor_hora: horaFinal });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FUNC_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar funcionário." });
  } finally {
    if (conn) conn.release();
  }
});

/** DELETE /api/funcionarios/:id */
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    const [result] = await pool.query(
      `DELETE FROM funcionarios WHERE id = ? AND empresa_id = ?`,
      [id, empresaId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Funcionário não encontrado na empresa." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("FUNC_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir funcionário." });
  }
});

export default router;