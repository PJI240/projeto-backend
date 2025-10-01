// src/routes/dashboard_func.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===================== auth / helpers básicos ===================== */
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

const pad2 = (n) => String(n).padStart(2, "0");
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function nowHHMM() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// mesmas validações do apontamentos.js
function isValidTimeHHMM(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ""));
}
function minutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/* ===================== funcionário do usuário na MESMA empresa ===================== */
async function getFuncionarioDoUsuario(empresaId, userId) {
  // Amarrou: empresas_usuarios -> usuarios_pessoas -> funcionarios (mesma empresa)
  const [rows] = await pool.query(
    `
    SELECT
      f.id,
      p.nome AS pessoa_nome,
      c.nome AS cargo_nome
    FROM empresas_usuarios eu
    JOIN usuarios_pessoas up ON up.usuario_id = eu.usuario_id AND up.empresa_id = eu.empresa_id
    JOIN pessoas          p  ON p.id = up.pessoa_id
    JOIN funcionarios     f  ON f.pessoa_id = p.id AND f.empresa_id = eu.empresa_id
    LEFT JOIN cargos      c  ON c.id = f.cargo_id
    WHERE eu.usuario_id = ? AND eu.empresa_id = ? AND eu.ativo = 1
    ORDER BY COALESCE(f.ativo,1) DESC, f.id ASC
    LIMIT 1
    `,
    [userId, empresaId]
  );
  return rows[0] || null;
}

/* ===================== GET /api/dashboard_func/hoje ===================== */
router.get("/hoje", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário/empresa." });

    const iso = todayISO();

    const [esc] = await pool.query(
      `SELECT id, entrada, saida, turno_ordem
         FROM escalas
        WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
        ORDER BY turno_ordem ASC`,
      [empresaId, func.id, iso]
    );

    const [ap] = await pool.query(
      `SELECT id, turno_ordem, entrada, saida, origem
         FROM apontamentos
        WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
        ORDER BY turno_ordem ASC, id ASC`,
      [empresaId, func.id, iso]
    );

    const aberto = ap.find(a => a.entrada && !a.saida);
    const estado = aberto ? "TRABALHANDO" : "FORA";

    return res.json({
      ok: true,
      empresa_id: empresaId,
      funcionario: func,
      data: iso,
      escala: esc,
      apontamentos: ap,
      estado,
    });
  } catch (e) {
    console.error("DASH_FUNC_HOJE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao carregar painel." });
  }
});

/* ===================== POST /api/dashboard_func/clock ===================== */
/** Alterna ENTRADA/SAÍDA do dia atual usando o mesmo padrão do apontamentos.js (HH:MM). */
router.post("/clock", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.body?.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário/empresa." });

    const iso = todayISO();
    const hhmm = nowHHMM();            // <- HH:MM
    if (!isValidTimeHHMM(hhmm)) {
      return res.status(400).json({ ok: false, error: "Horário inválido (HH:MM)." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [aps] = await conn.query(
      `SELECT id, turno_ordem, entrada, saida, origem
         FROM apontamentos
        WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
        ORDER BY turno_ordem ASC, id ASC`,
      [empresaId, func.id, iso]
    );

    const aberto = aps.find(a => a.entrada && !a.saida);

    if (aberto) {
      // SAÍDA: deve ser > ENTRADA (minutos)
      const mi = minutes(aberto.entrada);
      const mo = minutes(hhmm);
      if (mo == null || mi == null || mo <= mi) {
        await conn.rollback();
        return res.status(400).json({ ok: false, error: "Hora de saída deve ser posterior à entrada." });
        }
      await conn.query(
        `UPDATE apontamentos
            SET saida = ?, atualizado_em = NOW()
          WHERE id = ?`,
        [hhmm, aberto.id]
      );
      await conn.commit();
      return res.json({ ok: true, action: "saida", id: aberto.id, saida: hhmm });
    }

    // ENTRADA: novo registro com origem APONTADO
    const maxTurno = aps.reduce((m, a) => Math.max(m, Number(a.turno_ordem || 1)), 0) || 0;

    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs, criado_em, atualizado_em)
       VALUES (?,?,?,?,?,?,? ,NULL, NOW(), NOW())`,
      [empresaId, func.id, iso, maxTurno + 1, hhmm, null, "APONTADO"]
    );

    await conn.commit();
    return res.json({
      ok: true,
      action: "entrada",
      id: ins.insertId,
      entrada: hhmm,
      turno_ordem: maxTurno + 1,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("DASH_FUNC_CLOCK_ERR", e);
    const msg = String(e?.message || "");
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Duplicado: já existe lançamento idêntico." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao registrar ponto." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;