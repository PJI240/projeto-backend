// src/routes/folhas-funcionarios.js
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js"; // garante req.user.id

const router = express.Router();

/* ======================= helpers ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => {
  const s = norm(v);
  return s.length ? s : null;
};
const onlyYM = (s) => {
  const m = String(s || "").match(/^(\d{4})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}` : null;
};
const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function getUserRoles(userId) {
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => String(r.perfil || "").toLowerCase());
}
const isDev = (roles = []) =>
  roles.map((r) => String(r).toLowerCase()).includes("desenvolvedor");

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => Number(r.empresa_id));
}

/** Retorna a folha se estiver no escopo do usuário (empresa vinculada) */
async function getFolhaIfAllowed(userId, folhaId) {
  const roles = await getUserRoles(userId);
  const dev = isDev(roles);

  if (dev) {
    const [[f]] = await pool.query(
      `SELECT id, empresa_id, competencia, status
         FROM folhas
        WHERE id = ?
        LIMIT 1`,
      [Number(folhaId)]
    );
    if (!f) throw new Error("Folha não encontrada.");
    return f;
  }

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Sem empresa vinculada.");

  const [[row]] = await pool.query(
    `SELECT id, empresa_id, competencia, status
       FROM folhas
      WHERE id = ?
        AND empresa_id IN (?)
      LIMIT 1`,
    [Number(folhaId), empresas]
  );
  if (!row) throw new Error("Folha não encontrada ou fora do escopo.");
  return row;
}

/** Retorna {from,to} (YYYY-MM-DD) cobrindo todo o mês de uma competência YYYY-MM */
function monthRange(competenciaYM) {
  const [y, m] = String(competenciaYM).split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0));
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: iso(from), to: iso(to) };
}

/* ======================= ROTAS (escopo /api) ======================= */

router.use(requireAuth);

/** GET /api/folhas -> lista folhas visíveis ao usuário */
router.get("/folhas", async (req, res) => {
  try {
    const userId = req.user.id;
    const roles = await getUserRoles(userId);
    const dev = isDev(roles);

    let rows;
    if (dev) {
      [rows] = await pool.query(
        `SELECT id, empresa_id, competencia, status
           FROM folhas
         ORDER BY competencia DESC, id DESC`
      );
    } else {
      const empresas = await getUserEmpresaIds(userId);
      if (!empresas.length) return res.json({ ok: true, folhas: [] });
      [rows] = await pool.query(
        `SELECT id, empresa_id, competencia, status
           FROM folhas
          WHERE empresa_id IN (?)
          ORDER BY competencia DESC, id DESC`,
        [empresas]
      );
    }
    res.json({ ok: true, folhas: rows });
  } catch (e) {
    console.error("GET /folhas error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar folhas." });
  }
});

/** GET /api/folhas/:folhaId -> detalhe da folha */
router.get("/folhas/:folhaId", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    res.json({ ok: true, folha });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message || "Folha não encontrada." });
  }
});

/** GET /api/folhas/:folhaId/funcionarios -> lançamentos da folha (com nome/cpf) */
router.get("/folhas/:folhaId/funcionarios", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
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
      JOIN funcionarios f ON f.id = ff.funcionario_id AND f.empresa_id = ff.empresa_id
      JOIN pessoas      p ON p.id = f.pessoa_id
      WHERE ff.folha_id   = ?
        AND ff.empresa_id = ?
      ORDER BY p.nome ASC, ff.id ASC
      `,
      [folha.id, folha.empresa_id]
    );
    res.json({ ok: true, folhas_funcionarios: rows });
  } catch (e) {
    console.error("GET /folhas/:id/funcionarios error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao listar funcionários da folha." });
  }
});

/** GET /api/folhas/:folhaId/candidatos?search=... -> funcionários ativos da mesma empresa e NÃO incluídos */
router.get("/folhas/:folhaId/candidatos", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const q = normStr(req.query.search) || "";
    const like = `%${q.replace(/\s+/g, "%")}%`;

    const [rows] = await pool.query(
      `
      SELECT f.id AS funcionario_id, p.nome, p.cpf
        FROM funcionarios f
        JOIN pessoas p ON p.id = f.pessoa_id
       WHERE f.empresa_id = ?
         AND f.ativo = 1
         AND f.id NOT IN (
           SELECT funcionario_id
             FROM folhas_funcionarios
            WHERE folha_id = ?
              AND empresa_id = ?
         )
         ${q ? `
           AND (
              p.nome LIKE ?
              OR REPLACE(REPLACE(REPLACE(p.cpf,'.',''),'-',''),'/','')
                 LIKE REPLACE(REPLACE(REPLACE(?,'.',''),'-',''),'/','')
           )` : ""}
       ORDER BY p.nome ASC
       LIMIT 500
      `,
      q
        ? [folha.empresa_id, folha.id, folha.empresa_id, like, q]
        : [folha.empresa_id, folha.id, folha.empresa_id]
    );

    res.json({ ok: true, candidatos: rows });
  } catch (e) {
    console.error("GET /folhas/:id/candidatos error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao buscar candidatos." });
  }
});

/** POST /api/folhas/:folhaId/funcionarios { funcionario_id } -> inclui (bloqueia se folha FECHADA) */
router.post("/folhas/:folhaId/funcionarios", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const funcionarioId = Number(req.body?.funcionario_id);
    if (!funcionarioId) return res.status(400).json({ ok: false, error: "Informe funcionario_id." });

    const st = String(folha.status || "").toUpperCase();
    if (st !== "ABERTA") {
      return res.status(409).json({ ok: false, error: "Folha não permite novos lançamentos." });
    }

    await conn.beginTransaction();

    // funcionário precisa ser da mesma empresa e ativo
    const [[fok]] = await conn.query(
      `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? AND ativo = 1 LIMIT 1`,
      [funcionarioId, folha.empresa_id]
    );
    if (!fok) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Funcionário inválido para esta empresa." });
    }

    // evitar duplicidade
    const [[dup]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND empresa_id = ? AND funcionario_id = ? LIMIT 1`,
      [folha.id, folha.empresa_id, funcionarioId]
    );
    if (dup) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Funcionário já incluído nesta folha." });
    }

    const [ins] = await conn.query(
      `
      INSERT INTO folhas_funcionarios
        (empresa_id, folha_id, funcionario_id,
         horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100,
         descontos, proventos, total_liquido, inconsistencias)
      VALUES (?, ?, ?, 0,0,0, 0,0,0, 0,0,0, 0)
      `,
      [folha.empresa_id, folha.id, funcionarioId]
    );

    await conn.commit();
    res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    await conn.rollback();
    console.error("POST /folhas/:id/funcionarios error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao incluir funcionário." });
  } finally {
    conn.release();
  }
});

/** DELETE /api/folhas/:folhaId/funcionarios/:id -> remove lançamento da folha (scoped) */
router.delete("/folhas/:folhaId/funcionarios/:id", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const id = Number(req.params.id);
    await conn.beginTransaction();

    const [[ex]] = await conn.query(
      `SELECT id
         FROM folhas_funcionarios
        WHERE id = ? AND folha_id = ? AND empresa_id = ?
        LIMIT 1`,
      [id, folha.id, folha.empresa_id]
    );
    if (!ex) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Lançamento não encontrado." });
    }

    await conn.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await (conn?.rollback?.());
    if (e?.code === "ER_ROW_IS_REFERENCED_2" || e?.errno === 1451) {
      return res.status(409).json({ ok: false, error: "Não é possível excluir: registro referenciado." });
    }
    console.error("DELETE /folhas/:id/funcionarios/:id error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao remover." });
  } finally {
    conn.release();
  }
});

/* ======================= REGRA DE CÁLCULO =======================
   - Domingo (DAYOFWEEK = 1): tudo HE100
   - Seg–Sáb (2–7): até 8h/dia = horas_normais; excedente = HE50
   - valor_hora: funcionarios.valor_hora; se nulo, salario_base/220; senão 0
   - valores: base = vHora * horas_normais
              he50  = vHora * 1.5 * he50_horas
              he100 = vHora * 2.0 * he100_horas
*/
const DAILY_NORM_HOURS = 8;

/** POST /api/folhas/:folhaId/funcionarios/recalcular { ids?: number[] } */
router.post("/folhas/:folhaId/funcionarios/recalcular", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const { from, to } = monthRange(folha.competencia);

    // targets
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) {
      const [all] = await pool.query(
        `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND empresa_id = ?`,
        [folha.id, folha.empresa_id]
      );
      ids = all.map((r) => r.id);
    }
    if (ids.length === 0) return res.json({ ok: true, count: 0, results: [] });

    await conn.beginTransaction();

    // 1) Metadados dos lançamentos + valor_hora (fallback salario_base/220)
    const [ffRows] = await conn.query(
      `
      SELECT
        ff.id,
        ff.funcionario_id,
        ff.empresa_id,
        COALESCE(func.valor_hora,
                 CASE WHEN func.salario_base > 0 THEN func.salario_base / 220 ELSE 0 END,
                 0) AS valor_hora
      FROM folhas_funcionarios ff
      JOIN funcionarios func
            ON func.id = ff.funcionario_id
           AND func.empresa_id = ff.empresa_id
      WHERE ff.id IN (${ids.map(() => "?").join(",")})
        AND ff.folha_id = ?
        AND ff.empresa_id = ?
      `,
      [...ids, folha.id, folha.empresa_id]
    );

    if (ffRows.length === 0) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Nenhum lançamento encontrado na folha." });
    }

    const funcIds = ffRows.map((r) => r.funcionario_id);
    const byFFId = new Map(ffRows.map((r) => [r.id, r]));

    // 2) Minutos por dia/funcionário no período (ajuste para virada de dia)
    const placeholders = funcIds.map(() => "?").join(",");
    const [minPorDia] = await conn.query(
      `
      SELECT
        a.funcionario_id,
        a.data AS data,
        DAYOFWEEK(a.data) AS dow, -- 1=Domingo, 2=Seg, ..., 7=Sáb
        SUM(
          CASE
            WHEN a.entrada IS NOT NULL AND a.saida IS NOT NULL THEN
              GREATEST(
                TIMESTAMPDIFF(
                  MINUTE,
                  CONCAT(a.data,' ', a.entrada),
                  CASE
                    WHEN a.saida >= a.entrada
                      THEN CONCAT(a.data,' ', a.saida)
                    ELSE DATE_ADD(CONCAT(a.data,' ', a.saida), INTERVAL 1 DAY)
                  END
                ),
                0
              )
            ELSE 0
          END
        ) AS minutos
      FROM apontamentos a
      WHERE a.empresa_id = ?
        AND a.data BETWEEN ? AND ?
        AND a.funcionario_id IN (${placeholders})
      GROUP BY a.funcionario_id, a.data, dow
      ORDER BY a.funcionario_id, a.data
      `,
      [folha.empresa_id, from, to, ...funcIds]
    );

    // 3) Agrega por funcionário: separa normais, he50 e he100
    const normMinByFunc = new Map();  // funcionario_id -> minutos
    const he50MinByFunc = new Map();
    const he100MinByFunc = new Map();

    for (const row of minPorDia) {
      const fid = Number(row.funcionario_id);
      const dow = Number(row.dow);
      const minutos = Math.max(Number(row.minutos || 0), 0);

      if (dow === 1) {
        // Domingo: tudo HE100
        he100MinByFunc.set(fid, (he100MinByFunc.get(fid) || 0) + minutos);
      } else {
        // Seg–Sáb: até 8h normais, excedente HE50
        const dailyCap = DAILY_NORM_HOURS * 60;
        const norm = Math.min(minutos, dailyCap);
        const extra = Math.max(minutos - norm, 0);
        normMinByFunc.set(fid, (normMinByFunc.get(fid) || 0) + norm);
        he50MinByFunc.set(fid, (he50MinByFunc.get(fid) || 0) + extra);
      }
    }

    // 4) Aplica nos FF e calcula valores
    const results = [];
    for (const ffId of ids) {
      const meta = byFFId.get(ffId);
      if (!meta) {
        results.push({ id: ffId, ok: false, error: "Lançamento não pertence à folha." });
        continue;
      }

      const fid = meta.funcionario_id;
      const vHora = Number(meta.valor_hora || 0);

      const horas_normais = (normMinByFunc.get(fid) || 0) / 60;
      const he50_horas    = (he50MinByFunc.get(fid) || 0) / 60;
      const he100_horas   = (he100MinByFunc.get(fid) || 0) / 60;

      const valor_base  = vHora * horas_normais;
      const valor_he50  = vHora * 1.5 * he50_horas;
      const valor_he100 = vHora * 2.0 * he100_horas;

      const proventos      = valor_base + valor_he50 + valor_he100;
      const descontos      = 0;
      const total_liquido  = proventos - descontos;

      await conn.query(
        `
        UPDATE folhas_funcionarios
           SET horas_normais  = ?,
               he50_horas     = ?,
               he100_horas    = ?,
               valor_base     = ?,
               valor_he50     = ?,
               valor_he100    = ?,
               proventos      = ?,
               descontos      = ?,
               total_liquido  = ?,
               inconsistencias = 0
         WHERE id = ?
        `,
        [
          horas_normais,
          he50_horas,
          he100_horas,
          valor_base,
          valor_he50,
          valor_he100,
          proventos,
          descontos,
          total_liquido,
          ffId,
        ]
      );

      results.push({
        id: ffId,
        ok: true,
        valor_hora: vHora,
        horas_normais,
        he50_horas,
        he100_horas,
        proventos,
        total_liquido,
      });
    }

    await conn.commit();
    return res.json({ ok: true, count: results.length, results, period: { from, to } });
  } catch (e) {
    await (conn?.rollback?.());
    console.error("RECALC_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao recalcular." });
  } finally {
    conn.release();
  }
});

export default router;