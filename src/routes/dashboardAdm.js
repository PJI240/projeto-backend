// src/routes/dashboardAdm.js
import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

/** ========= Auth simples (req.userId deve ser preenchido por middleware global) ========= */
function mustBeAuthed(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: "Não autenticado." });
  next();
}

/** ========= Empresas do usuário ========= */
async function getEmpresaIdsByUser(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

/** ========= Helpers de datas ========= */
const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekRange() {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7; // 0 = segunda
  const seg = new Date(today); seg.setDate(today.getDate() - dow);
  const dom = new Date(seg);   dom.setDate(seg.getDate() + 6);
  return { from: toISO(seg), to: toISO(dom) };
}

/** ========= Consultas básicas ========= */
async function fetchFuncionarios(empresaIds, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT f.id,
           f.empresa_id,
           f.ativo,
           p.nome  AS pessoa_nome,
           c.nome  AS cargo_nome
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
    SELECT
      e.id,
      e.empresa_id,
      e.funcionario_id,
      DATE_FORMAT(e.data, '%Y-%m-%d')    AS data,
      e.turno_ordem,
      TIME_FORMAT(e.entrada, '%H:%i:%s') AS entrada,
      TIME_FORMAT(e.saida,   '%H:%i:%s') AS saida,
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

async function fetchApontamentos(empresaIds, from, to, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT
      a.id,
      a.funcionario_id,
      DATE_FORMAT(a.data, '%Y-%m-%d')         AS data,
      a.turno_ordem,
      UPPER(TRIM(a.evento))                   AS evento,        -- ENTRADA | SAIDA (sem espaços)
      TIME_FORMAT(a.horario, '%H:%i:%s')      AS horario,       -- HH:MM:SS
      UPPER(TRIM(a.origem))                   AS origem,        -- APONTADO | AJUSTE | IMPORTADO
      a.status_tratamento,
      a.is_rep_oficial,
      a.nsr,
      a.tz,
      a.coletor_id,
      a.obs
    FROM apontamentos a
    JOIN funcionarios f ON f.id = a.funcionario_id
    WHERE f.empresa_id IN (?)
      ${apenasAtivos ? "AND f.ativo = 1" : ""}
      AND a.data BETWEEN ? AND ?
    ORDER BY a.data ASC,
             a.funcionario_id ASC,
             a.turno_ordem ASC,
             a.horario ASC,
             a.id ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

/** ========= Endpoint agregado =========
 * GET /api/dashboard/adm?from=YYYY-MM-DD&to=YYYY-MM-DD
 * GET /api/dashboard/adm?data=YYYY-MM-DD
 * (opcional) ?ativos=1
 */
router.get("/dashboard/adm", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) {
      return res.json({ funcionarios: [], escalas: [], apontamentos: [], period: null });
    }

    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const data = (req.query.data || "").trim();
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();

    if (data) { from = data; to = data; }
    if (!from || !to) ({ from, to } = weekRange());

    const [funcionarios, escalas, apontamentos] = await Promise.all([
      fetchFuncionarios(empresaIds, apenasAtivos),
      fetchEscalas(empresaIds, from, to, apenasAtivos),
      fetchApontamentos(empresaIds, from, to, apenasAtivos),
    ]);

    return res.json({ funcionarios, escalas, apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/dashboard/adm error:", e);
    return res.status(500).json({ ok: false, error: "Falha ao montar dashboard." });
  }
});

/** ========= Endpoints que o FRONT já consome ========= */

/** GET /api/funcionarios?ativos=1 */
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

/** GET /api/escalas?from=YYYY-MM-DD&to=YYYY-MM-DD&ativos=1 */
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

/** GET /api/apontamentos?from=YYYY-MM-DD&to=YYYY-MM-DD&ativos=1 */
router.get("/apontamentos", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ apontamentos: [] });

    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());

    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const apontamentos = await fetchApontamentos(empresaIds, from, to, apenasAtivos);
    res.json({ apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/apontamentos error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar apontamentos." });
  }
});

/** ========= Debug opcional ========= */
router.get("/dashboard/adm/debug", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) {
      return res.json({ empresaIds: [], totals: { funcionarios: 0, escalas: 0, apontamentos: 0 } });
    }

    const data = (req.query.data || new Date().toISOString().slice(0, 10)).trim();

    const [[f]] = await pool.query(
      `SELECT COUNT(*) n FROM funcionarios WHERE empresa_id IN (?)`,
      [empresaIds]
    );
    const [[e]] = await pool.query(
      `
      SELECT COUNT(*) n
        FROM escalas e
        JOIN funcionarios f ON f.id = e.funcionario_id
       WHERE f.empresa_id IN (?)
         AND e.data = ?
      `,
      [empresaIds, data]
    );
    const [[ap]] = await pool.query(
      `
      SELECT COUNT(*) n
        FROM apontamentos a
        JOIN funcionarios f ON f.id = a.funcionario_id
       WHERE f.empresa_id IN (?)
         AND a.data = ?
      `,
      [empresaIds, data]
    );

    res.json({ data, empresaIds, totals: { funcionarios: f.n, escalas: e.n, apontamentos: ap.n } });
  } catch (e) {
    console.error("GET /api/dashboard/adm/debug error:", e);
    res.status(500).json({ ok: false, error: "Falha no debug." });
  }
});

export default router;