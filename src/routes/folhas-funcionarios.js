import { Router } from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

/* ============================================================
 * Helpers
 * ============================================================ */
function normDec(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v).trim();
  if (s.includes(",") && !s.includes(".")) {
    return Number(s.replace(/\./g, "").replace(",", ".")) || 0;
  }
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  return Number(cleaned) || 0;
}
const toInt = (v) => Number.parseInt(v, 10) || 0;

async function getFolha(folhaId) {
  const [[folha]] = await pool.query(
    `SELECT id, empresa_id, competencia, status
       FROM folhas
      WHERE id = ?`,
    [folhaId]
  );
  if (!folha) throw new Error("Folha inexistente.");
  return folha;
}

function competenciaToPeriodo(competencia /* 'YYYY-MM' */) {
  // Início = primeiro dia; Fim = último dia (23:59:59.999)
  const [yy, mm] = (competencia || "").split("-").map(Number);
  if (!yy || !mm) throw new Error("Competência inválida.");
  const ini = new Date(Date.UTC(yy, mm - 1, 1, 0, 0, 0));
  const fim = new Date(Date.UTC(yy, mm, 0, 23, 59, 59, 999)); // dia 0 do mês seguinte
  // Retornar como strings MySQL
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return { ini: iso(ini), fim: iso(fim) };
}

/* ============================================================
 * GET /api/folhas/:folhaId
 *  -> detalhe da folha
 * ============================================================ */
router.get("/folhas/:folhaId", requireAuth, async (req, res) => {
  try {
    const folhaId = toInt(req.params.folhaId);
    const folha = await getFolha(folhaId);
    return res.json(folha);
  } catch (e) {
    console.error("FF_GET_FOLHA_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao carregar a folha." });
  }
});

/* ============================================================
 * GET /api/folhas/:folhaId/funcionarios
 *  -> lista enriquecida (nome/cpf) com totais
 * ============================================================ */
router.get("/folhas/:folhaId/funcionarios", requireAuth, async (req, res) => {
  try {
    const folhaId = toInt(req.params.folhaId);
    const folha = await getFolha(folhaId);

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

    return res.json(rows);
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar." });
  }
});

/* ============================================================
 * GET /api/folhas/:folhaId/candidatos?search={q}
 *  -> funcionários ativos da mesma empresa e NÃO incluídos na folha
 * ============================================================ */
router.get("/folhas/:folhaId/candidatos", requireAuth, async (req, res) => {
  try {
    const folhaId = toInt(req.params.folhaId);
    const folha = await getFolha(folhaId);
    const q = String(req.query.search || "").trim();

    const like = `%${q.replace(/\s+/g, "%")}%`;
    const params = [folha.empresa_id, folhaId];
    let whereQ = "";

    if (q.length >= 2) {
      whereQ = `AND (p.nome LIKE ? OR p.cpf LIKE ?)`;
      params.push(like, like);
    }

    const [rows] = await pool.query(
      `
      SELECT f.id AS funcionario_id, p.nome, p.cpf
      FROM funcionarios f
      JOIN pessoas p    ON p.id = f.pessoa_id
      WHERE f.empresa_id = ?
        AND f.ativo = 1
        AND f.id NOT IN (SELECT funcionario_id FROM folhas_funcionarios WHERE folha_id = ?)
        ${whereQ}
      ORDER BY p.nome ASC
      LIMIT 50
      `,
      params
    );

    return res.json(rows);
  } catch (e) {
    console.error("FF_CAND_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao buscar candidatos." });
  }
});

/* ============================================================
 * POST /api/folhas/:folhaId/funcionarios
 * body: { funcionario_id }
 * -> cria vínculo vazio e já dispara recálculo desse funcionário
 * ============================================================ */
router.post("/folhas/:folhaId/funcionarios", requireAuth, async (req, res) => {
  let conn;
  try {
    const folhaId = toInt(req.params.folhaId);
    const funcionarioId = toInt(req.body?.funcionario_id);
    if (!folhaId || !funcionarioId) return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });

    const folha = await getFolha(folhaId);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Evita duplicidade do mesmo funcionário na mesma folha
    const [[exists]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND funcionario_id = ? LIMIT 1`,
      [folhaId, funcionarioId]
    );
    if (exists) throw new Error("Funcionário já incluído nesta folha.");

    const [ins] = await conn.query(
      `
      INSERT INTO folhas_funcionarios
        (empresa_id, folha_id, funcionario_id,
         horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100,
         descontos, proventos, total_liquido, inconsistencias)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
      `,
      [folha.empresa_id, folhaId, funcionarioId]
    );

    await conn.commit();

    // Recalcula fora da transação principal (mas sincrono aqui)
    await recalcFolhaFuncionario(folhaId, ins.insertId);

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao incluir funcionário." });
  } finally {
    if (conn) conn?.release();
  }
});

/* ============================================================
 * DELETE /api/folhas/:folhaId/funcionarios/:id
 *  -> remove vínculo
 * ============================================================ */
router.delete("/folhas/:folhaId/funcionarios/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const id = toInt(req.params.id);
    const folhaId = toInt(req.params.folhaId);
    if (!id || !folhaId) return res.status(400).json({ ok: false, error: "Parâmetros inválidos." });

    await getFolha(folhaId); // valida existência

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[ex]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE id = ? AND folha_id = ? LIMIT 1`,
      [id, folhaId]
    );
    if (!ex) throw new Error("Vínculo não encontrado.");

    await conn.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);
    await conn.commit();

    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao remover." });
  } finally {
    if (conn) conn?.release();
  }
});

/* ============================================================
 * POST /api/folhas/:folhaId/funcionarios/recalcular
 * body: { ids?: number[] }  -> recalcula somente estes; se omitido, recalcula todos
 * ============================================================ */
router.post("/folhas/:folhaId/funcionarios/recalcular", requireAuth, async (req, res) => {
  try {
    const folhaId = toInt(req.params.folhaId);
    await getFolha(folhaId); // valida

    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(toInt).filter(Boolean) : [];

    if (ids.length === 0) {
      const [all] = await pool.query(
        `SELECT id FROM folhas_funcionarios WHERE folha_id = ? ORDER BY id ASC`,
        [folhaId]
      );
      ids = all.map((r) => r.id);
    }

    const results = [];
    for (const id of ids) {
      try {
        await recalcFolhaFuncionario(folhaId, id);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message || "Falha no recálculo." });
      }
    }

    return res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error("FF_RECALC_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao recalcular." });
  }
});

/* ============================================================
 * Core de recálculo (1 registro de folhas_funcionarios)
 *  - Soma horas por dia a partir de vw_jornada_tratada
 *  - Regras: até 8h/dia = normal; 8–10h = HE50; >10h = HE100
 *  - valor_hora = COALESCE(funcionarios.valor_hora, funcionarios.salario_base/220)
 *  - valores: base = horas_normais * valor_hora
 *             he50  = he50_horas  * valor_hora * 1.5
 *             he100 = he100_horas * valor_hora * 2.0
 *  - total_liquido = base + he50 + he100 + proventos - descontos (mantém proventos/descontos já existentes)
 *  - inconsistencias = qtd de apontamentos INVALIDADA no período
 * ============================================================ */
async function recalcFolhaFuncionario(folhaId, folhaFuncId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[ff]] = await conn.query(
      `
      SELECT ff.id, ff.funcionario_id, f.empresa_id, fo.competencia
      FROM folhas_funcionarios ff
      JOIN folhas fo ON fo.id = ff.folha_id
      JOIN funcionarios f ON f.id = ff.funcionario_id
      WHERE ff.id = ? AND ff.folha_id = ?
      LIMIT 1
      `,
      [folhaFuncId, folhaId]
    );
    if (!ff) throw new Error("Vínculo não encontrado para recálculo.");

    const { ini, fim } = competenciaToPeriodo(ff.competencia);

    // 1) Horas por dia a partir da view consolidada
    //    diária <= 8h => normal
    //    8-10 => HE50
    //    >10  => HE100
    const [hrs] = await conn.query(
      `
      SELECT
        SUM(LEAST(daily_secs, 8*3600)) / 3600        AS horas_normais,
        SUM(GREATEST(LEAST(daily_secs, 10*3600) - 8*3600, 0)) / 3600  AS he50_horas,
        SUM(GREATEST(daily_secs - 10*3600, 0)) / 3600                  AS he100_horas
      FROM (
        SELECT v.data,
               SUM(TIME_TO_SEC(TIMEDIFF(v.saida, v.entrada))) AS daily_secs
          FROM vw_jornada_tratada v
         WHERE v.funcionario_id = ?
           AND v.data BETWEEN DATE(?) AND DATE(?)
         GROUP BY v.data
      ) d
      `,
      [ff.funcionario_id, ini, fim]
    );

    const horas_normais = Number(hrs?.[0]?.horas_normais || 0);
    const he50_horas    = Number(hrs?.[0]?.he50_horas || 0);
    const he100_horas   = Number(hrs?.[0]?.he100_horas || 0);

    // 2) Valor hora
    const [[vh]] = await conn.query(
      `SELECT COALESCE(f.valor_hora, f.salario_base/220) AS valor_hora
         FROM funcionarios f
        WHERE f.id = ?
        LIMIT 1`,
      [ff.funcionario_id]
    );
    const valor_hora = Number(vh?.valor_hora || 0);

    // 3) Proventos/descontos atuais (mantemos)
    const [[cur]] = await conn.query(
      `SELECT COALESCE(proventos,0) proventos, COALESCE(descontos,0) descontos
         FROM folhas_funcionarios
        WHERE id = ?
        LIMIT 1`,
      [folhaFuncId]
    );
    const proventos = Number(cur?.proventos || 0);
    const descontos = Number(cur?.descontos || 0);

    // 4) Valores
    const valor_base  = +(horas_normais * valor_hora).toFixed(2);
    const valor_he50  = +(he50_horas   * valor_hora * 1.5).toFixed(2);
    const valor_he100 = +(he100_horas  * valor_hora * 2.0).toFixed(2);

    // 5) Inconsistências: apontamentos INVALIDADA no período
    const [[inc]] = await conn.query(
      `
      SELECT COUNT(*) AS q
        FROM apontamentos a
       WHERE a.funcionario_id = ?
         AND a.status_tratamento = 'INVALIDADA'
         AND a.data BETWEEN DATE(?) AND DATE(?)
      `,
      [ff.funcionario_id, ini, fim]
    );
    const inconsistencias = Number(inc?.q || 0);

    const total_liquido = +(valor_base + valor_he50 + valor_he100 + proventos - descontos).toFixed(2);

    await conn.query(
      `
      UPDATE folhas_funcionarios
         SET horas_normais = ?,
             he50_horas    = ?,
             he100_horas   = ?,
             valor_base    = ?,
             valor_he50    = ?,
             valor_he100   = ?,
             total_liquido = ?,
             inconsistencias = ?
       WHERE id = ?
      `,
      [
        horas_normais,
        he50_horas,
        he100_horas,
        valor_base,
        valor_he50,
        valor_he100,
        total_liquido,
        inconsistencias,
        folhaFuncId,
      ]
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

export default router;