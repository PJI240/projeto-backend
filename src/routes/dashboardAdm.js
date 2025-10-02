// routes/dashboardAdm.js
import { Router } from "express";
import { pool } from "../db.js";

/**
 * Este router expõe:
 *   GET /api/dashboard/adm?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   ou
 *   GET /api/dashboard/adm?data=YYYY-MM-DD          (apenas um dia)
 *
 * Retorno: { funcionarios:[], escalas:[], apontamentos:[] }
 *
 * Pré-requisito: algum middleware de auth deve preencher req.userId
 * (o seu requireAuth do projeto já faz isso).
 */

const router = Router();

// segurança básica: só prossegue se req.userId existir
function mustBeAuthed(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: "Não autenticado." });
  next();
}

// empresas às quais o usuário pertence
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
      return res.json({ funcionarios: [], escalas: [], apontamentos: [] });
    }

    // período: prioridade para ?data=YYYY-MM-DD (dia único)
    // senão usa ?from & ?to; se não vier nada, assume a semana do "data" (ou de hoje)
    const data = (req.query.data || "").trim();
    let from = (req.query.from || "").trim();
    let to   = (req.query.to || "").trim();

    if (data) {
      from = data;
      to   = data;
    }

    // fallback de período: se não recebido, usa a semana corrente (Seg..Dom)
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

    // ================== consultas ==================
    // 1) Funcionários (ativos opcional)
    const apenasAtivos = String(req.query.ativos || "0") === "1";

    const [funcRows] = await pool.query(
      `
      SELECT f.id,
             f.empresa_id,
             f.ativo,
             p.nome   AS pessoa_nome,
             c.nome   AS cargo_nome
        FROM funcionarios f
        JOIN pessoas     p ON p.id = f.pessoa_id
        JOIN cargos      c ON c.id = f.cargo_id
       WHERE f.empresa_id IN (?)
         ${apenasAtivos ? "AND f.ativo = 1" : ""}
      `,
      [empresaIds]
    );

    // 2) Escalas no período
    const [escRows] = await pool.query(
      `
      SELECT e.*
        FROM escalas e
       WHERE e.empresa_id IN (?)
         AND e.data BETWEEN ? AND ?
       ORDER BY e.data ASC, e.funcionario_id ASC, e.turno_ordem ASC
      `,
      [empresaIds, from, to]
    );

    // 3) Apontamentos no período
    const [apoRows] = await pool.query(
      `
      SELECT a.*
        FROM apontamentos a
       WHERE a.empresa_id IN (?)
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

export default router;
