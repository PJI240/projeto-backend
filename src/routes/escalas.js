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
  return empresas[0]; // default
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

/** Se ambos horários existem, garante entrada < saída */
function assertEntradaAntesSaida(entrada, saida) {
  if (!entrada || !saida) return;
  const [h1, m1] = entrada.split(":").map(Number);
  const [h2, m2] = saida.split(":").map(Number);
  const a = h1 * 60 + m1;
  const b = h2 * 60 + m2;
  if (!(a < b)) throw new Error("Horário de entrada deve ser anterior ao horário de saída.");
}

/** Valida uma escala individual */
function validarEscala(escala, empresaId) {
  const {
    funcionario_id,
    data,
    turno_ordem = 1,
    entrada = null,
    saida = null,
    origem = "FIXA",
  } = escala || {};

  if (!Number(funcionario_id) || !isValidISODate(data)) {
    throw new Error("Funcionário e data são obrigatórios.");
  }
  if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
    throw new Error("Horários inválidos (HH:MM).");
  }
  assertEntradaAntesSaida(entrada, saida);

  return {
    empresa_id: empresaId,
    funcionario_id: Number(funcionario_id),
    data,
    turno_ordem: clampTurno(turno_ordem),
    entrada: entrada || null,
    saida: saida || null,
    origem: normOrigem(origem),
  };
}

/* ===================== POST /api/escalas/batch ===================== */
/**
 * Body: {
 *   escalas: [{
 *     funcionario_id: number,
 *     data: "YYYY-MM-DD",
 *     turno_ordem: number (>=1),
 *     entrada: "HH:MM" | null,
 *     saida:   "HH:MM" | null,
 *     origem: "FIXA" | "EXCECAO"
 *   }]
 * }
 * 
 * Retorna: { ok:true, message: string, escalas: array com IDs inseridos }
 */
router.post("/batch", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { escalas } = req.body || {};

    if (!Array.isArray(escalas)) {
      return res.status(400).json({ ok: false, error: "Array 'escalas' é obrigatório." });
    }

    if (escalas.length === 0) {
      return res.status(400).json({ ok: false, error: "Array 'escalas' não pode estar vazio." });
    }

    if (escalas.length > 100) {
      return res.status(400).json({ ok: false, error: "Máximo de 100 escalas por lote." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validar e preparar todas as escalas
    const escalasValidadas = [];
    const funcionariosVerificados = new Set();

    for (let i = 0; i < escalas.length; i++) {
      try {
        const escala = escalas[i];
        const escalaValidada = validarEscala(escala, empresaId);
        
        // Verificar funcionário apenas uma vez por ID
        if (!funcionariosVerificados.has(escalaValidada.funcionario_id)) {
          await assertFuncionarioEmpresa(conn, escalaValidada.funcionario_id, empresaId);
          funcionariosVerificados.add(escalaValidada.funcionario_id);
        }
        
        escalasValidadas.push(escalaValidada);
      } catch (e) {
        await conn.rollback();
        return res.status(400).json({ 
          ok: false, 
          error: `Erro na escala ${i + 1}: ${e.message}` 
        });
      }
    }

    // Inserir em lote
    const escalasInseridas = [];
    for (const escala of escalasValidadas) {
      try {
        const [ins] = await conn.query(
          `INSERT INTO escalas
             (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem)
           VALUES (?,?,?,?,?,?,?)`,
          [
            escala.empresa_id,
            escala.funcionario_id,
            escala.data,
            escala.turno_ordem,
            escala.entrada,
            escala.saida,
            escala.origem,
          ]
        );
        escalasInseridas.push({ ...escala, id: ins.insertId });
      } catch (e) {
        const msg = String(e?.message || "");
        if (/Duplicate entry/i.test(msg)) {
          await conn.rollback();
          return res.status(409).json({ 
            ok: false, 
            error: `Já existe um turno para o funcionário na data ${escala.data}.` 
          });
        }
        throw e;
      }
    }

    await conn.commit();
    
    return res.json({ 
      ok: true, 
      message: `${escalasInseridas.length} escalas criadas com sucesso.`,
      escalas: escalasInseridas 
    });

  } catch (e) {
    if (conn) await conn.rollback();
    console.error("ESCALAS_BATCH_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar escalas em lote." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== GET /api/escalas ===================== */
/**
 * Lista escalas da empresa do usuário dentro de um intervalo (inclusive).
 * Query:
 *   - from=YYYY-MM-DD
 *   - to=YYYY-MM-DD
 *   - empresa_id (opcional)
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

    // Formata no SELECT: data em YYYY-MM-DD, times em HH:MM (sem segundos)
    const [rows] = await pool.query(
      `
        SELECT
          e.id,
          e.empresa_id,
          e.funcionario_id,
          DATE_FORMAT(e.data, '%Y-%m-%d')        AS data,
          e.turno_ordem,
          TIME_FORMAT(e.entrada, '%H:%i')        AS entrada,
          TIME_FORMAT(e.saida,   '%H:%i')        AS saida,
          e.origem
        FROM escalas e
        WHERE e.empresa_id = ?
          AND e.data BETWEEN ? AND ?
        ORDER BY e.funcionario_id ASC, e.data ASC, e.turno_ordem ASC
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
 * Body: {
 *   funcionario_id: number,
 *   data: "YYYY-MM-DD",
 *   turno_ordem: number (>=1),
 *   entrada: "HH:MM" | null,
 *   saida:   "HH:MM" | null,
 *   origem: "FIXA" | "EXCECAO"
 * }
 * Unicidade recomendada: (empresa_id, funcionario_id, data, turno_ordem)
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
    assertEntradaAntesSaida(entrada, saida);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

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
    assertEntradaAntesSaida(entrada, saida);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // verifica se o registro é da empresa
    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM escalas WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Escala não encontrada para a empresa selecionada.");
    }

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

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
