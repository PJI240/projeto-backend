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

/** Empresas acessíveis ao usuário (via usuarios_pessoas → funcionarios) */
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

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem vínculo a nenhuma empresa.");

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
function isValidHHMM(s = "") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s.trim()));
}
function normalizeHHMM(v) {
  if (v == null) return null;
  const p = String(v).trim().split(":");
  if (p.length >= 2) return `${p[0].padStart(2, "0")}:${p[1].padStart(2, "0")}`;
  return null;
}
function clampTurno(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
function normOrigem(s = "APONTADO") {
  const t = String(s || "").toUpperCase();
  return ["APONTADO", "IMPORTADO", "AJUSTE"].includes(t) ? t : "APONTADO";
}
function isEvento(e) {
  const t = String(e || "").toUpperCase();
  return t === "ENTRADA" || t === "SAIDA";
}

/** Confere se o funcionário pertence à empresa */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [funcionarioId, empresaId]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}

/* ===================== GET /api/apontamentos ===================== */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { from, to, funcionario_id, origem, evento } = req.query || {};

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
    if (evento) {
      const ev = String(evento || "").toUpperCase();
      if (ev !== "ENTRADA" && ev !== "SAIDA") {
        return res.status(400).json({ ok: false, error: "Evento deve ser ENTRADA ou SAIDA." });
      }
      extra += " AND evento = ? ";
      params.push(ev);
    }

    // >>> AQUI: data formatada como string 'YYYY-MM-DD'
    const [rows] = await pool.query(
      `
        SELECT
          id,
          empresa_id,
          funcionario_id,
          DATE_FORMAT(data, '%Y-%m-%d') AS data,
          turno_ordem,
          evento,
          horario,
          origem,
          status_tratamento,
          obs,
          is_rep_oficial,
          nsr,
          tz,
          dt_marcacao,
          dt_gravacao,
          coletor_id
        FROM apontamentos
        WHERE empresa_id = ?
          AND data BETWEEN ? AND ?
          ${extra}
        ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC, horario ASC, id ASC
      `,
      params
    );

    return res.json({ ok: true, empresa_id: empresaId, apontamentos: rows });
  } catch (e) {
    console.error("APONT_LIST_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao listar apontamentos." });
  }
});

/* ===================== POST /api/apontamentos ===================== */
/* Cria 1 evento (ENTRADA ou SAIDA) */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const {
      funcionario_id,
      data,
      turno_ordem = 1,
      evento,
      horario,
      origem = "AJUSTE", // por padrão, cadastros manuais são PTRP/AJUSTE
      status_tratamento = "VALIDA",
      obs = null,
    } = req.body || {};

    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isEvento(evento)) {
      return res.status(400).json({ ok: false, error: "Evento deve ser ENTRADA ou SAIDA." });
    }
    const hhmm = normalizeHHMM(horario);
    if (!hhmm || !isValidHHMM(hhmm)) {
      return res.status(400).json({ ok: false, error: "Horário inválido. Use HH:MM." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    // prevenir duplicidade lógica do mesmo evento
    const [dup] = await conn.query(
      `SELECT id FROM apontamentos
        WHERE empresa_id=? AND funcionario_id=? AND data=?
          AND turno_ordem=? AND evento=? AND horario=? AND origem=?`,
      [empresaId, Number(funcionario_id), data, clampTurno(turno_ordem), String(evento).toUpperCase(), hhmm, normOrigem(origem)]
    );
    if (dup.length) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Evento duplicado para o mesmo turno/horário." });
    }

    // Não mexe em nsr/hash/oficial aqui (rota administrativa/PTRP).
    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, funcionario_id, data, turno_ordem,
          evento, horario, origem, status_tratamento, obs)
       VALUES (?,?,?,?, ?,?,?,?, ?)`,
      [
        empresaId,
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        String(evento).toUpperCase(),
        hhmm,
        normOrigem(origem),
        String(status_tratamento || "VALIDA").toUpperCase() === "INVALIDADA" ? "INVALIDADA" : "VALIDA",
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
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade." });
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
      evento,
      horario,
      origem = "AJUSTE",
      status_tratamento = "VALIDA",
      obs = null,
    } = req.body || {};

    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });
    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }
    if (!isEvento(evento)) {
      return res.status(400).json({ ok: false, error: "Evento deve ser ENTRADA ou SAIDA." });
    }
    const hhmm = normalizeHHMM(horario);
    if (!hhmm || !isValidHHMM(hhmm)) {
      return res.status(400).json({ ok: false, error: "Horário inválido. Use HH:MM." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Confere empresa do registro
    const [[row]] = await conn.query(
      `SELECT id, empresa_id, is_rep_oficial FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }
    if (row.is_rep_oficial === 1) {
      throw new Error("Apontamento oficial é imutável. Use PTRP/AJUSTE.");
    }

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    await conn.query(
      `UPDATE apontamentos
          SET funcionario_id = ?,
              data = ?,
              turno_ordem = ?,
              evento = ?,
              horario = ?,
              origem = ?,
              status_tratamento = ?,
              obs = ?
        WHERE id = ?`,
      [
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        String(evento).toUpperCase(),
        hhmm,
        normOrigem(origem),
        String(status_tratamento || "VALIDA").toUpperCase() === "INVALIDADA" ? "INVALIDADA" : "VALIDA",
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
    if (/duplicad|duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade." });
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
      `SELECT id, empresa_id, is_rep_oficial FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }
    if (row.is_rep_oficial === 1) {
      throw new Error("Apontamento oficial não pode ser excluído. Use PTRP/AJUSTE.");
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
 * Espera rows no formato:
 * [{ funcionario_id, data: 'YYYY-MM-DD', turno_ordem, evento: 'ENTRADA'|'SAIDA', horario: 'HH:MM', origem, obs }]
 * CSV (se usar no front): funcionario_id;data;turno_ordem;evento;horario;origem;obs
 */
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
      const evento = String(r.evento || "").toUpperCase();
      const horario = normalizeHHMM(r.horario);
      const origem = normOrigem(r.origem);
      const obs = r.obs || null;

      let erro = "";
      if (!funcionario_id) erro = "funcionario_id vazio";
      else if (!isValidISODate(data)) erro = "data inválida (YYYY-MM-DD)";
      else if (!isEvento(evento)) erro = "evento inválido (ENTRADA/SAIDA)";
      else if (!horario || !isValidHHMM(horario)) erro = "horario inválido (HH:MM)";

      if (erro) {
        invalidas.push({ index: i, motivo: erro, dados: { funcionario_id, data, evento, horario } });
        continue;
      }

      try {
        await assertFuncionarioEmpresa(conn, funcionario_id, empresaId);

        // evitar duplicidade lógica
        const [dup] = await conn.query(
          `SELECT id FROM apontamentos
             WHERE empresa_id=? AND funcionario_id=? AND data=? AND turno_ordem=? AND evento=? AND horario=? AND origem=?`,
          [empresaId, funcionario_id, data, turno_ordem, evento, horario, origem]
        );
        if (dup.length) {
          duplicadas++;
          continue;
        }

        await conn.query(
          `INSERT INTO apontamentos
             (empresa_id, funcionario_id, data, turno_ordem, evento, horario, origem, status_tratamento, obs)
           VALUES (?,?,?,?, ?,?,?, 'VALIDA', ?)`,
          [empresaId, funcionario_id, data, turno_ordem, evento, horario, origem, obs]
        );
        inseridas++;
      } catch (e) {
        invalidas.push({ index: i, motivo: "erro: " + String(e?.message || e), dados: { funcionario_id, data, evento, horario } });
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