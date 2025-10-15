// src/routes/adm_dashboard.js
import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

function mustBeAuthed(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: "Não autenticado." });
  next();
}

async function getEmpresaIdsByUser(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id FROM empresas_usuarios WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map(r => r.empresa_id);
}

const pad = n => String(n).padStart(2, "0");
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekRange() {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const seg = new Date(today); seg.setDate(today.getDate() - dow);
  const dom = new Date(seg);   dom.setDate(seg.getDate() + 6);
  return { from: toISO(seg), to: toISO(dom) };
}

async function fetchFuncionarios(empresaIds, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT f.id, f.empresa_id, f.ativo, p.nome AS pessoa_nome, c.nome AS cargo_nome
      FROM funcionarios f
      JOIN pessoas     p ON p.id = f.pessoa_id
      LEFT JOIN cargos c ON c.id = f.cargo_id
     WHERE f.empresa_id IN (?)
       ${apenasAtivos ? "AND f.ativo = 1" : ""}
     ORDER BY p.nome ASC
    `,
    [empresaIds]
  );
  return rows;
}

async function fetchEscalas(empresaIds, from, to, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT e.id,
           e.empresa_id,
           e.funcionario_id,
           DATE_FORMAT(e.data, '%Y-%m-%d') AS data,
           e.turno_ordem,
           TIME_FORMAT(e.entrada, '%H:%i')  AS entrada,
           TIME_FORMAT(e.saida,   '%H:%i')  AS saida,
           e.origem
      FROM escalas e
      JOIN funcionarios f ON f.id = e.funcionario_id
     WHERE f.empresa_id IN (?)
       ${apenasAtivos ? "AND f.ativo = 1" : ""}
       AND e.data BETWEEN ? AND ?
     ORDER BY e.data ASC, e.funcionario_id ASC, e.turno_ordem ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

/**
 * Consolida apontamentos linha-a-linha (ENTRADA/SAIDA) em pares por dia/func/turno:
 * - entrada = MIN(horario/entrada) onde evento='ENTRADA'
 * - saida   = MAX(horario/saida)   onde evento='SAIDA'
 * Prioriza a coluna `horario`; se nula, usa `entrada/saida`.
 * Filtra por status quando solicitado.
 */
async function fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos, somenteValidos = true) {
  if (!empresaIds.length) return [];
  const filtroStatus = somenteValidos
    ? `AND COALESCE(a.status_tratamento,'VALIDA') IN ('VALIDA','VALIDADA')`
    : ``;

  const [rows] = await pool.query(
    `
    WITH base AS (
      SELECT
        a.funcionario_id,
        a.turno_ordem,
        DATE(a.data) AS data,
        UPPER(a.evento) AS evento,
        COALESCE(a.horario, CASE WHEN UPPER(a.evento)='ENTRADA' THEN a.entrada ELSE a.saida END) AS t_ref,
        UPPER(TRIM(a.origem)) AS origem
      FROM apontamentos a
      JOIN funcionarios f ON f.id = a.funcionario_id
     WHERE f.empresa_id IN (?)
       ${apenasAtivos ? "AND f.ativo = 1" : ""}
       AND a.data BETWEEN ? AND ?
       ${filtroStatus}
    ),
    ent AS (
      SELECT data, funcionario_id, turno_ordem,
             TIME_FORMAT(MIN(t_ref), '%H:%i') AS entrada
      FROM base
      WHERE evento='ENTRADA' AND t_ref IS NOT NULL
      GROUP BY data, funcionario_id, turno_ordem
    ),
    sai AS (
      SELECT data, funcionario_id, turno_ordem,
             TIME_FORMAT(MAX(t_ref), '%H:%i') AS saida
      FROM base
      WHERE evento='SAIDA' AND t_ref IS NOT NULL
      GROUP BY data, funcionario_id, turno_ordem
    )
    SELECT
      DATE_FORMAT(COALESCE(e.data, s.data), '%Y-%m-%d') AS data,
      COALESCE(e.funcionario_id, s.funcionario_id)       AS funcionario_id,
      COALESCE(e.turno_ordem,     s.turno_ordem)         AS turno_ordem,
      e.entrada,
      s.saida,
      'CONSOLIDADO' AS origem
    FROM ent e
    FULL JOIN sai s
      ON s.data=e.data AND s.funcionario_id=e.funcionario_id AND s.turno_ordem=e.turno_ordem
    ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

/* ====================== ENDPOINTS ====================== */

router.get("/dashboard/adm", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) {
      return res.json({ funcionarios: [], escalas: [], apontamentos: [], period: null });
    }

    const apenasAtivos = String(req.query.ativos || "1") === "1";
    const somenteValidos = String(req.query.somente_validos || "1") === "1";
    const data = (req.query.data || "").trim();
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();

    if (data) { from = data; to = data; }
    if (!from || !to) ({ from, to } = weekRange());

    const [funcionarios, escalas, apontamentos] = await Promise.all([
      fetchFuncionarios(empresaIds, apenasAtivos),
      fetchEscalas(empresaIds, from, to, apenasAtivos),
      fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos, somenteValidos),
    ]);

    return res.json({ funcionarios, escalas, apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/dashboard/adm error:", e);
    return res.status(500).json({ ok: false, error: "Falha ao montar dashboard." });
  }
});

router.get("/funcionarios", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const funcionarios = await fetchFuncionarios(empresaIds, apenasAtivos);
    res.json({ funcionarios });
  } catch (e) {
    console.error("GET /api/funcionarios error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar funcionários." });
  }
});

router.get("/escalas", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ escalas: [] });

    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());

    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const escalas = await fetchEscalas(empresaIds, from, to, apenasAtivos);
    res.json({ escalas, period: { from, to } });
  } catch (e) {
    console.error("GET /api/escalas error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar escalas." });
  }
});

router.get("/apontamentos", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ apontamentos: [] });

    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());

    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const somenteValidos = String(req.query.somente_validos || "1") === "1";

    const apontamentos = await fetchApontamentosConsolidados(
      empresaIds, from, to, apenasAtivos, somenteValidos
    );
    res.json({ apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/apontamentos error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar apontamentos." });
  }
});

/**
 * Debug de presença “ao vivo”: quem está presente agora numa data (default hoje).
 * Regra: existe ENTRADA <= agora e (não há SAÍDA > ENTRADA no mesmo turno) até o momento.
 */
router.get("/dashboard/adm/debug/presentes", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ data: null, presentes: [] });

    const hoje = new Date();
    const data = (req.query.data || toISO(hoje)).trim();
    const hhmm = `${pad(hoje.getHours())}:${pad(hoje.getMinutes())}`;

    const [rows] = await pool.query(
      `
      WITH base AS (
        SELECT a.funcionario_id, a.turno_ordem, UPPER(a.evento) AS evento,
               COALESCE(a.horario, CASE WHEN UPPER(a.evento)='ENTRADA' THEN a.entrada ELSE a.saida END) AS t_ref
          FROM apontamentos a
          JOIN funcionarios f ON f.id = a.funcionario_id
         WHERE f.empresa_id IN (?)
           AND a.data = ?
           AND COALESCE(a.status_tratamento,'VALIDA') IN ('VALIDA','VALIDADA')
      ),
      ent AS (
        SELECT funcionario_id, turno_ordem, MIN(t_ref) AS t_entrada
          FROM base WHERE evento='ENTRADA' AND t_ref IS NOT NULL
         GROUP BY funcionario_id, turno_ordem
      ),
      sai AS (
        SELECT funcionario_id, turno_ordem, MAX(t_ref) AS t_saida
          FROM base WHERE evento='SAIDA' AND t_ref IS NOT NULL
         GROUP BY funcionario_id, turno_ordem
      )
      SELECT e.funcionario_id, e.turno_ordem,
             TIME_FORMAT(e.t_entrada, '%H:%i') AS entrada,
             TIME_FORMAT(s.t_saida,   '%H:%i') AS saida
        FROM ent e
        LEFT JOIN sai s
          ON s.funcionario_id=e.funcionario_id AND s.turno_ordem=e.turno_ordem
       WHERE TIME_FORMAT(e.t_entrada, '%H:%i') <= ?
         AND (s.t_saida IS NULL OR TIME_FORMAT(s.t_saida, '%H:%i') > TIME_FORMAT(e.t_entrada, '%H:%i'))
       ORDER BY e.funcionario_id, e.turno_ordem
      `,
      [empresaIds, data, hhmm]
    );

    res.json({ data, agora: hhmm, presentes: rows });
  } catch (e) {
    console.error("GET /api/dashboard/adm/debug/presentes error:", e);
    res.status(500).json({ ok: false, error: "Falha no debug de presença." });
  }
});

export default router;