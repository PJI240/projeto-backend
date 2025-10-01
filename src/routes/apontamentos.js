// src/routes/apontamentos.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===================== helpers ===================== */

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
function normOrigem(s = "APONTADO") {
  const t = String(s || "").toUpperCase();
  return ["APONTADO", "IMPORTADO", "AJUSTE"].includes(t) ? t : "APONTADO";
}
function minutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Garante que o funcionário pertence à empresa em questão */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [funcionarioId, empresaId]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}

/* ===================== GET /api/apontamentos ===================== */
/**
 * Lista apontamentos do período (inclusive).
 * Query:
 *   - from=YYYY-MM-DD
 *   - to=YYYY-MM-DD
 *   - funcionario_id (opcional)
 *   - origem (opcional) APONTADO|IMPORTADO|AJUSTE
 *   - empresa_id (opcional)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { from, to, funcionario_id, origem } = req.query || {};

    if (!isValidISODate(from) || !isValidISODate(to)) {
      return res.status(400).json({ ok: false, error: "Parâmetros 'from' e 'to' devem estar em YYYY-MM-DD." });
    }

    const params = [empresaId, from, to];
    let extra = "";
    if (funcionario_id) {
      extra += " AND funcionario_id = ? ";
      params.push(Number(funcionario_id));
    }
    if (origem) {
      extra += " AND origem = ? ";
      params.push(normOrigem(origem));
    }

    const [rows] = await pool.query(
      `
        SELECT id, empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs
          FROM apontamentos
         WHERE empresa_id = ?
           AND data BETWEEN ? AND ?
           ${extra}
         ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC
      `,
      params
    );

    return res.json({ ok: true, empresa_id: empresaId, apontamentos: rows });
  } catch (e) {
    console.error("APONT_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar apontamentos." });
  }
});

/* ===================== POST /api/apontamentos ===================== */
/**
 * Body: {
 *   funcionario_id, data(YYYY-MM-DD), turno_ordem(>=1),
 *   entrada(HH:MM|null), saida(HH:MM|null), origem, obs?
 * }
 * Unicidade: (empresa_id, funcionario_id, data, turno_ordem, origem)
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
      origem = "APONTADO",
      obs = null,
    } = req.body || {};

    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res.status(400).json({ ok: false, error: "Horários inválidos (HH:MM)." });
    }
    // regra simples: se ambos existem, saída >= entrada
    if (entrada && saida) {
      const mi = minutes(entrada), mo = minutes(saida);
      if (mo < mi) {
        return res.status(400).json({ ok: false, error: "Saída menor que a entrada. Para virada de dia, use dois apontamentos." });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        empresaId,
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entrada || null,
        saida || null,
        normOrigem(origem),
        obs || null,
      ]
    );

    await conn.commit();
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("APONT_CREATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Duplicado: já existe apontamento com mesma chave (funcionário, data, turno, origem)." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/apontamentos/:id ===================== */
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
      origem = "APONTADO",
      obs = null,
    } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });
    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res.status(400).json({ ok: false, error: "Horários inválidos (HH:MM)." });
    }
    if (entrada && saida) {
      const mi = minutes(entrada), mo = minutes(saida);
      if (mo < mi) {
        return res.status(400).json({ ok: false, error: "Saída menor que a entrada. Para virada de dia, use dois apontamentos." });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // verifica se pertence à empresa
    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    await conn.query(
      `UPDATE apontamentos
          SET funcionario_id = ?,
              data = ?,
              turno_ordem = ?,
              entrada = ?,
              saida = ?,
              origem = ?,
              obs = ?
        WHERE id = ?`,
      [
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entrada || null,
        saida || null,
        normOrigem(origem),
        obs || null,
        id,
      ]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("APONT_UPDATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Duplicado: mesma chave (funcionário, data, turno, origem)." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao atualizar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/apontamentos/:id ===================== */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }

    await conn.query(`DELETE FROM apontamentos WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("APONT_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== POST /api/apontamentos/import ===================== */
/**
 * Body: { rows: [{ funcionario_id, data, turno_ordem, entrada, saida, origem, obs }] }
 * Importa apenas válidas; retorna resumo.
 */
router.post("/import", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ ok: false, error: "Nenhuma linha para importar." });
    if (rows.length > 5000) return res.status(400).json({ ok: false, error: "Limite de 5000 linhas por importação." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let inseridas = 0;
    let duplicadas = 0;
    const invalidas = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const funcionario_id = Number(r.funcionario_id);
      const data = r.data;
      const turno_ordem = clampTurno(r.turno_ordem);
      const entrada = r.entrada || null;
      const saida = r.saida || null;
      const origem = normOrigem(r.origem);
      const obs = r.obs || null;

      // validações básicas
      let erro = "";
      if (!funcionario_id) erro = "funcionario_id vazio";
      else if (!isValidISODate(data)) erro = "data inválida (YYYY-MM-DD)";
      else if (!isValidTimeOrNull(entrada)) erro = "entrada inválida";
      else if (!isValidTimeOrNull(saida)) erro = "saida inválida";
      else if (entrada && saida && minutes(saida) < minutes(entrada)) erro = "saida < entrada";

      if (erro) {
        invalidas.push({ index: i, motivo: erro });
        continue;
      }

      try {
        await assertFuncionarioEmpresa(conn, funcionario_id, empresaId);
        await conn.query(
          `INSERT INTO apontamentos
             (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
           VALUES (?,?,?,?,?,?,?,?)`,
          [empresaId, funcionario_id, data, turno_ordem, entrada, saida, origem, obs]
        );
        inseridas++;
      } catch (e) {
        const msg = String(e?.message || "");
        if (/Duplicate entry/i.test(msg)) {
          duplicadas++;
          continue;
        }
        invalidas.push({ index: i, motivo: "erro inesperado" });
      }
    }

    await conn.commit();
    return res.json({
      ok: true,
      resumo: { inseridas, duplicadas, invalidas: invalidas.length },
      invalidas,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("APONT_IMPORT_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao importar apontamentos." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
