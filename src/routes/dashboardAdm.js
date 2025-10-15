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

async function fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    WITH apontamentos_validos AS (
      SELECT 
        a.funcionario_id,
        a.turno_ordem,
        DATE(a.data) AS data,
        a.evento,
        COALESCE(a.horario, 
                 CASE WHEN a.evento = 'ENTRADA' THEN a.entrada 
                      WHEN a.evento = 'SAIDA' THEN a.saida 
                 END) AS horario_real,
        a.origem
      FROM apontamentos a
      JOIN funcionarios f ON f.id = a.funcionario_id
      WHERE f.empresa_id IN (?)
        ${apenasAtivos ? "AND f.ativo = 1" : ""}
        AND a.data BETWEEN ? AND ?
        AND COALESCE(a.status_tratamento, 'VALIDA') = 'VALIDA'
    ),
    entradas AS (
      SELECT 
        data,
        funcionario_id,
        turno_ordem,
        TIME_FORMAT(MIN(horario_real), '%H:%i') AS entrada
      FROM apontamentos_validos
      WHERE evento = 'ENTRADA' AND horario_real IS NOT NULL
      GROUP BY data, funcionario_id, turno_ordem
    ),
    saidas AS (
      SELECT 
        data,
        funcionario_id,
        turno_ordem,
        TIME_FORMAT(MAX(horario_real), '%H:%i') AS saida
      FROM apontamentos_validos
      WHERE evento = 'SAIDA' AND horario_real IS NOT NULL
      GROUP BY data, funcionario_id, turno_ordem
    )
    SELECT 
      e.data,
      e.funcionario_id,
      e.turno_ordem,
      e.entrada,
      s.saida,
      CASE 
        WHEN e.entrada IS NOT NULL AND s.saida IS NULL THEN 'PRESENTE'
        ELSE 'APONTADO'
      END AS status_presenca,
      'APONTADO' AS origem
    FROM entradas e
    LEFT JOIN saidas s ON s.data = e.data 
                      AND s.funcionario_id = e.funcionario_id 
                      AND s.turno_ordem = e.turno_ordem
    
    UNION ALL
    
    SELECT 
      s.data,
      s.funcionario_id,
      s.turno_ordem,
      e.entrada,
      s.saida,
      'AUSENTE' AS status_presenca,
      'APONTADO' AS origem
    FROM saidas s
    LEFT JOIN entradas e ON e.data = s.data 
                        AND e.funcionario_id = s.funcionario_id 
                        AND e.turno_ordem = s.turno_ordem
    WHERE e.funcionario_id IS NULL
    
    ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

router.get("/dashboard/adm", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length)
      return res.json({ funcionarios: [], escalas: [], apontamentos: [], period: null });

    const apenasAtivos = String(req.query.ativos || "1") === "1";
    const data = (req.query.data || "").trim();
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();

    if (data) { from = data; to = data; }
    if (!from || !to) ({ from, to } = weekRange());

    const [funcionarios, escalas, apontamentos] = await Promise.all([
      fetchFuncionarios(empresaIds, apenasAtivos),
      fetchEscalas(empresaIds, from, to, apenasAtivos),
      fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos),
    ]);

    res.json({ funcionarios, escalas, apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/dashboard/adm error:", e);
    res.status(500).json({ ok: false, error: "Falha ao montar dashboard." });
  }
});

router.get("/apontamentos", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ apontamentos: [] });

    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());

    const apenasAtivos = String(req.query.ativos || "1") === "1";
    const apontamentos = await fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos);
    res.json({ apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/apontamentos error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar apontamentos." });
  }
});

export default router;
