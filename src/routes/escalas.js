// src/routes/escalas.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===================== helpers/comuns ===================== */

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
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

/** Resolve a empresa corrente (query ?empresa_id precisa estar na lista do usuário) */
async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");

  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0]; // default: primeira da lista do usuário
}

function isValidISODate(s = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}
function isValidTimeOrNull(s) {
  if (s == null || s === "") return true;
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));
}
function clampTurno(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
function normOrigem(s = "FIXA") {
  const t = String(s || "").toUpperCase();
  return ["FIXA", "EXCECAO"].includes(t) ? t : "FIXA";
}

/** Garante que o funcionário pertence à empresa em questão */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [funcionarioId, empresaId]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}

/* ===================== GET /api/escalas ===================== */
/**
 * Lista escalas da empresa do usuário dentro de um intervalo (inclusive).
 * Query:
 *   - from=YYYY-MM-DD
 *   - to=YYYY-MM-DD
 *   - empresa_id (opcional, se usuário tiver várias)
 *
 * Retorna: { ok:true, empresa_id, escalas:[{ id, funcionario_id, data, turno_ordem, entrada, saida, origem }] }
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { from, to } = req.query || {};

    if (!isValidISODate(from) || !isValidISODate(to)) {
      return res.status(400).json({ ok: false, error: "Parâmetros 'from' e 'to' devem estar em YYYY-MM-DD." });
    }

    const [rows] = await pool.query(
      `
        SELECT id, empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem
          FROM escalas
         WHERE empresa_id = ?
           AND data BETWEEN ? AND ?
         ORDER BY funcionario_id ASC, data ASC, turno_ordem ASC
      `,
      [empresaId, from, to]
    );

    return res.json({ ok: true, empresa_id: empresaId, escalas: rows });
  } catch (e) {
    console.error("ESCALAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar escalas." });
  }
});

/* ===================== POST /api/escalas ===================== */
/**
 * Cria uma escala (turno) para um funcionário.
 * Body: {
 *   funcionario_id: number,
 *   data: "YYYY-MM-DD",
 *   turno_ordem: number (>=1),
 *   entrada: "HH:MM" | null,
 *   saida: "HH:MM" | null,
 *   origem: "FIXA" | "EXCECAO"
 * }
 * Regra de unicidade: (empresa_id, funcionario_id, data, turno_ordem)
 */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const {
      funcionario_id,
      data,
      turno_ordem = 1,
      entrada = null,
      saida = null,
      origem = "FIXA",
    } = req.body || {};

    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res.status(400).json({ ok: false, error: "Horários inválidos (HH:MM)." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    // insere
    const [ins] = await conn.query(
      `INSERT INTO escalas
         (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem)
       VALUES (?,?,?,?,?,?,?)`,
      [
        empresaId,
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entrada || null,
        saida || null,
        normOrigem(origem),
      ]
    );

    await conn.commit();
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("ESCALAS_CREATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Já existe um turno com esta ordem para o mesmo dia/funcionário." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar escala." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/escalas/:id ===================== */
/**
 * Atualiza um turno de escala existente.
 * Mesmos campos do POST; respeita unicidade.
 */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    const {
      funcionario_id,
      data,
      turno_ordem = 1,
      entrada = null,
      saida = null,
      origem = "FIXA",
    } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });
    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res.status(400).json({ ok: false, error: "Horários inválidos (HH:MM)." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // verifica se o registro é da empresa
    const [[row]] = await conn.query(
      `SELECT id, empresa_id, funcionario_id FROM escalas WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Escala não encontrada para a empresa selecionada.");
    }

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    // atualiza
    await conn.query(
      `UPDATE escalas
          SET funcionario_id = ?,
              data = ?,
              turno_ordem = ?,
              entrada = ?,
              saida = ?,
              origem = ?
        WHERE id = ?`,
      [
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entrada || null,
        saida || null,
        normOrigem(origem),
        id,
      ]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("ESCALAS_UPDATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Já existe um turno com esta ordem para o mesmo dia/funcionário." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao atualizar escala." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/escalas/:id ===================== */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM escalas WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Escala não encontrada para a empresa selecionada.");
    }

    await conn.query(`DELETE FROM escalas WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("ESCALAS_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir escala." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
