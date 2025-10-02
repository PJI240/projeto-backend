// routes/dashboardAdm.js
import { Router } from "express";
import { pool } from "../db.js";

/**
 * Endpoints:
 *   GET /api/dashboard/adm?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/dashboard/adm?data=YYYY-MM-DD               // um dia
 *   (opcional) ?ativos=1  -> apenas funcionários ativos
 *
 * Retorno: { funcionarios:[], escalas:[], apontamentos:[], period:{from,to} }
 * Requer: req.userId preenchido pelo middleware de auth.
 */

const router = Router();

// Middleware simples de auth
function mustBeAuthed(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: "Não autenticado." });
  next();
}

// Obtém IDs de empresas às quais o usuário pertence
async function getEmpresaIdsByUser(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map(r => r.empresa_id);
}

router.get("/dashboard/adm", mustBeAuthed, async (req, res) => {
  try {
    const userId = req.userId;
    const empresaIds = await getEmpresaIdsByUser(userId);

    if (!empresaIds.length) {
      return res.json({ funcionarios: [], escalas: [], apontamentos: [], period: null });
    }

    // Período: ?data (um dia) OU ?from&to; senão, semana corrente (Seg..Dom)
    const data = String(req.query.data || "").trim();
    let from = String(req.query.from || "").trim();
    let to   = String(req.query.to   || "").trim();

    if (data) { from = data; to = data; }

    if (!from || !to) {
      const today = new Date();
      const dow = (today.getDay() + 6) % 7; // 0=Seg
      const seg = new Date(today); seg.setDate(today.getDate() - dow);
      const dom = new Date(seg);   dom.setDate(seg.getDate() + 6);
      const pad = n => String(n).padStart(2, "0");
      const toISO = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      from = toISO(seg);
      to   = toISO(dom);
    }

    const apenasAtivos = String(req.query.ativos || "0") === "1";

    // ================== CONSULTAS ==================

    // 1) Funcionários (JOIN pessoas/cargos)
    const [funcRows] = await pool.query(
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
      `,
      [empresaIds]
    );

    // 2) Escalas no período (JOIN funcionarios para garantir empresa)
    const [escRows] = await pool.query(
      `
      SELECT e.id,
             e.empresa_id,
             e.funcionario_id,
             e.data,
             e.turno_ordem,
             TIME_FORMAT(e.entrada, '%H:%i:%s') AS entrada,
             TIME_FORMAT(e.saida,   '%H:%i:%s') AS saida,
             e.origem
        FROM escalas e
        JOIN funcionarios f ON f.id = e.funcionario_id
       WHERE f.empresa_id IN (?)
         AND e.data BETWEEN ? AND ?
       ORDER BY e.data ASC, e.funcionario_id ASC, e.turno_ordem ASC
      `,
      [empresaIds, from, to]
    );

    // 3) Apontamentos no período (JOIN funcionarios + normalização)
    const [apoRows] = await pool.query(
      `
      SELECT a.id,
             a.funcionario_id,
             a.data,
             a.turno_ordem,
             TIME_FORMAT(a.entrada, '%H:%i:%s') AS entrada,
             TIME_FORMAT(a.saida,   '%H:%i:%s') AS saida,
             UPPER(TRIM(a.origem)) AS origem,
             a.obs
        FROM apontamentos a
        JOIN funcionarios f ON f.id = a.funcionario_id
       WHERE f.empresa_id IN (?)
         AND a.data BETWEEN ? AND ?
       ORDER BY a.data ASC, a.funcionario_id ASC, a.turno_ordem ASC, a.origem ASC
      `,
      [empresaIds, from, to]
    );

    return res.json({
      funcionarios: funcRows,
      escalas: escRows,
      apontamentos: apoRows,
      period: { from, to }
    });
  } catch (e) {
    console.error("GET /api/dashboard/adm error:", e);
    return res.status(500).json({ ok: false, error: "Falha ao montar dashboard." });
  }
});

// (Opcional) Rota de debug rápido para contagens do dia
router.get("/dashboard/adm/debug", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ empresaIds: [], totals: { funcionarios: 0, escalas: 0, apontamentos: 0 } });

    const data = (req.query.data || new Date().toISOString().slice(0,10)).trim();

    const [[f]]  = await pool.query(`SELECT COUNT(*) n FROM funcionarios WHERE empresa_id IN (?)`, [empresaIds]);
    const [[e]]  = await pool.query(`
      SELECT COUNT(*) n
        FROM escalas e
        JOIN funcionarios f ON f.id = e.funcionario_id
       WHERE f.empresa_id IN (?) AND e.data = ?`, [empresaIds, data]);
    const [[ap]] = await pool.query(`
      SELECT COUNT(*) n
        FROM apontamentos a
        JOIN funcionarios f ON f.id = a.funcionario_id
       WHERE f.empresa_id IN (?) AND a.data = ?`, [empresaIds, data]);

    res.json({ data, empresaIds, totals: { funcionarios: f.n, escalas: e.n, apontamentos: ap.n } });
  } catch (e) {
    console.error("GET /api/dashboard/adm/debug error:", e);
    res.status(500).json({ ok: false, error: "Falha no debug." });
  }
});

export default router;
