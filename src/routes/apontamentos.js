// src/routes/apontamentos.js
import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

/* ===================== helpers ===================== */

/** Empresas acessíveis ao usuário:
 *  usuarios_pessoas → (pessoa_id) → funcionarios → (empresa_id)
 *  Fallback: se não houver funcionário ativo, usa o empresa_id da própria usuarios_pessoas
 */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `
    SELECT DISTINCT COALESCE(f.empresa_id, up.empresa_id) AS empresa_id
      FROM usuarios_pessoas up
 LEFT JOIN funcionarios f
        ON f.pessoa_id = up.pessoa_id
       AND (f.ativo = 1 OR f.ativo IS NULL)
     WHERE up.usuario_id = ?
    `,
    [userId]
  );
  return rows.map((r) => r.empresa_id).filter((v) => v != null);
}

/** Resolve empresa do contexto validando contra as empresas do usuário */
async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem vínculo a nenhuma empresa.");
  if (empresaIdQuery != null && empresaIdQuery !== "") {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada para o usuário.");
  }
  return empresas[0];
}

function isValidISODate(s = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}
function normalizeTime(hhmm) {
  if (!hhmm) return null;
  const str = String(hhmm).trim();
  return str.split(":").slice(0, 2).join(":"); // HH:MM
}
function isValidTimeOrNull(s) {
  if (s == null || s === "") return true;
  const str = String(s).trim();
  return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(str); // HH:MM ou HH:MM:SS
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
/** Confirma se o funcionário pertence à empresa informada */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [funcionarioId, empresaId]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}
/** Valida horários permitindo noturno (saída < entrada), com limites razoáveis */
function validateHorarios(entrada, saida) {
  if (!entrada || !saida) return null;
  const mi = minutes(entrada);
  const mo = minutes(saida);
  if (mi == null || mo == null) return null;
  const diff = mo < mi ? mo + 1440 - mi : mo - mi; // até virar o dia
  if (diff < 1) return "Diferença mínima de 1 minuto entre entrada e saída";
  if (diff > 18 * 60) return "Jornada muito longa (máximo 18 horas)";
  return null;
}

/* ===================== GET /api/apontamentos ===================== */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { from, to, funcionario_id, origem } = req.query || {};
    if (!isValidISODate(from) || !isValidISODate(to)) {
      return res
        .status(400)
        .json({ ok: false, error: "Parâmetros 'from' e 'to' devem estar em YYYY-MM-DD." });
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

    const entradaNorm = entrada ? normalizeTime(entrada) : null;
    const saidaNorm = saida ? normalizeTime(saida) : null;

    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res
        .status(400)
        .json({ ok: false, error: "Horários inválidos (formato HH:MM ou HH:MM:SS)." });
    }
    if (entradaNorm && saidaNorm) {
      const err = validateHorarios(entradaNorm, saidaNorm);
      if (err) return res.status(400).json({ ok: false, error: err });
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
        entradaNorm,
        saidaNorm,
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
      return res.status(409).json({
        ok: false,
        error:
          "Duplicado: já existe apontamento com mesma chave (funcionário, data, turno, origem).",
      });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/apontamentos/:id ===================== */
/* Política: não editar oficiais. Só permite UPDATE se origem = 'AJUSTE'. */
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

    const entradaNorm = entrada ? normalizeTime(entrada) : null;
    const saidaNorm = saida ? normalizeTime(saida) : null;

    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      return res
        .status(400)
        .json({ ok: false, error: "Horários inválidos (formato HH:MM ou HH:MM:SS)." });
    }
    if (entradaNorm && saidaNorm) {
      const err = validateHorarios(entradaNorm, saidaNorm);
      if (err) return res.status(400).json({ ok: false, error: err });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id, origem FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }
    if (String(row.origem || "").toUpperCase() !== "AJUSTE") {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        error:
          "Edição bloqueada para apontamento oficial. Use PTRP para invalidar e criar um AJUSTE.",
      });
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
        entradaNorm,
        saidaNorm,
        "AJUSTE", // força manter como AJUSTE
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
      return res
        .status(409)
        .json({ ok: false, error: "Duplicado: mesma chave (funcionário, data, turno, origem)." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao atualizar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/apontamentos/:id ===================== */
/* Política: não excluir oficiais. Só permite DELETE se origem = 'AJUSTE'. */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id, origem FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }
    if (String(row.origem || "").toUpperCase() !== "AJUSTE") {
      await conn.rollback();
      return res.status(403).json({
        ok: false,
        error:
          "Exclusão bloqueada para apontamento oficial. Use PTRP para invalidar e criar um AJUSTE.",
      });
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
router.post("/import", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ ok: false, error: "Nenhuma linha para importar." });
    if (rows.length > 5000)
      return res.status(400).json({ ok: false, error: "Limite de 5000 linhas por importação." });

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

      const entradaNorm = entrada ? normalizeTime(entrada) : null;
      const saidaNorm = saida ? normalizeTime(saida) : null;

      let erro = "";
      if (!funcionario_id) erro = "funcionario_id vazio";
      else if (!isValidISODate(data)) erro = "data inválida (YYYY-MM-DD)";
      else if (!isValidTimeOrNull(entrada)) erro = "entrada inválida";
      else if (!isValidTimeOrNull(saida)) erro = "saida inválida";
      else if (entradaNorm && saidaNorm) {
        const val = validateHorarios(entradaNorm, saidaNorm);
        if (val) erro = val;
      }

      if (erro) {
        invalidas.push({ index: i, motivo: erro, dados: { funcionario_id, data, entrada, saida } });
        continue;
      }

      try {
        await assertFuncionarioEmpresa(conn, funcionario_id, empresaId);
        await conn.query(
          `INSERT INTO apontamentos
             (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
           VALUES (?,?,?,?,?,?,?,?)`,
          [empresaId, funcionario_id, data, turno_ordem, entradaNorm, saidaNorm, origem, obs]
        );
        inseridas++;
      } catch (e) {
        const msg = String(e?.message || "");
        if (/Duplicate entry/i.test(msg)) {
          duplicadas++;
          continue;
        }
        invalidas.push({
          index: i,
          motivo: "erro inesperado: " + msg,
          dados: { funcionario_id, data, entrada, saida },
        });
      }
    }

    await conn.commit();
    return res.json({
      ok: true,
      resumo: { inseridas, duplicadas, invalidas: invalidas.length },
      invalidas: invalidas.slice(0, 100),
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