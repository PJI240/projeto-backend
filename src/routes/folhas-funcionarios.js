import { Router } from "express";
import { pool } from "../db.js";
// opcional
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

/* ---- LISTA DE FOLHAS ----
GET /api/folhas
retorna [{ id, competencia, status, empresa_id }]
*/
router.get("/folhas", /*requireAuth,*/ async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, empresa_id, competencia, status
         FROM folhas
       ORDER BY competencia DESC, id DESC`
    );
    res.json({ folhas: rows });
  } catch (e) {
    console.error("F_LIST_ERR", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao listar folhas." });
  }
});

/* ---- DETALHE DA FOLHA ----
GET /api/folhas/:folhaId
*/
router.get("/folhas/:folhaId", /*requireAuth,*/ async (req, res) => {
  try {
    const folhaId = Number(req.params.folhaId);
    const [[row]] = await pool.query(
      `SELECT id, empresa_id, competencia, status
         FROM folhas
        WHERE id = ?
        LIMIT 1`, [folhaId]
    );
    if (!row) return res.status(404).json({ ok:false, error:"Folha não encontrada." });
    res.json(row);
  } catch (e) {
    console.error("F_GET_ERR", e);
    res.status(400).json({ ok:false, error: e.message || "Falha ao obter folha." });
  }
});

/* ---- FUNCIONÁRIOS DA FOLHA ----
GET /api/folhas/:folhaId/funcionarios
*/
router.get("/folhas/:folhaId/funcionarios", /*requireAuth,*/ async (req, res) => {
  try {
    const folhaId = Number(req.params.folhaId);
    const [rows] = await pool.query(
      `
      SELECT
        ff.id,
        ff.empresa_id,
        ff.folha_id,
        ff.funcionario_id,
        ff.horas_normais,
        ff.he50_horas,
        ff.he100_horas,
        ff.valor_base,
        ff.valor_he50,
        ff.valor_he100,
        ff.descontos,
        ff.proventos,
        ff.total_liquido,
        ff.inconsistencias,
        p.nome,
        p.cpf
      FROM folhas_funcionarios ff
      JOIN funcionarios f ON f.id = ff.funcionario_id
      JOIN pessoas      p ON p.id = f.pessoa_id
      WHERE ff.folha_id = ?
      ORDER BY p.nome ASC, ff.id ASC
      `,
      [folhaId]
    );
    res.json(rows);
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    res.status(400).json({ ok:false, error: e.message || "Falha ao listar funcionários da folha." });
  }
});

export default router;