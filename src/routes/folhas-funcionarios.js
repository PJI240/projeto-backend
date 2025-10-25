import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

/* ======================= helpers ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => {
  const s = norm(v);
  return s.length ? s : null;
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

/* Converte competência (YYYY-MM) para { from, to } */
function monthRange(competenciaYM) {
  const [y, m] = String(competenciaYM).split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0));
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: iso(from), to: iso(to) };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/* ======================= ROTAS ======================= */
router.use(requireAuth);

/** GET /api/folhas */
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

/** GET /api/folhas/:folhaId */
router.get("/folhas/:folhaId", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    res.json({ ok: true, folha });
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message || "Folha não encontrada." });
  }
});

/** GET /api/folhas/:folhaId/funcionarios */
router.get("/folhas/:folhaId/funcionarios", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const [rows] = await pool.query(
      `
      SELECT ff.id, ff.empresa_id, ff.folha_id, ff.funcionario_id,
             ff.horas_normais, ff.he50_horas, ff.he100_horas,
             ff.valor_base, ff.valor_he50, ff.valor_he100,
             ff.descontos, ff.proventos, ff.total_liquido,
             ff.inconsistencias, p.nome, p.cpf
        FROM folhas_funcionarios ff
        JOIN funcionarios f ON f.id = ff.funcionario_id AND f.empresa_id = ff.empresa_id
        JOIN pessoas p ON p.id = f.pessoa_id
       WHERE ff.folha_id = ? AND ff.empresa_id = ?
       ORDER BY p.nome ASC
      `,
      [folha.id, folha.empresa_id]
    );
    res.json({ ok: true, folhas_funcionarios: rows });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: "Falha ao listar funcionários da folha." });
  }
});

/** GET /api/folhas/:folhaId/candidatos */
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
           SELECT funcionario_id FROM folhas_funcionarios
            WHERE folha_id = ? AND empresa_id = ?
         )
         ${q ? "AND (p.nome LIKE ? OR p.cpf LIKE ?)" : ""}
       ORDER BY p.nome ASC
       LIMIT 500
      `,
      q ? [folha.empresa_id, folha.id, folha.empresa_id, like, like] : [folha.empresa_id, folha.id, folha.empresa_id]
    );
    res.json({ ok: true, candidatos: rows });
  } catch (e) {
    console.error(e);
    res.status(400).json({ ok: false, error: "Falha ao buscar candidatos." });
  }
});

/** POST /api/folhas/:folhaId/funcionarios */
router.post("/folhas/:folhaId/funcionarios", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const funcionarioId = Number(req.body?.funcionario_id);
    if (!funcionarioId) return res.status(400).json({ ok: false, error: "Informe funcionario_id." });
    if (String(folha.status).toUpperCase() !== "ABERTA")
      return res.status(409).json({ ok: false, error: "Folha não permite novos lançamentos." });

    await conn.beginTransaction();
    const [[valid]] = await conn.query(
      `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? AND ativo = 1`,
      [funcionarioId, folha.empresa_id]
    );
    if (!valid) throw new Error("Funcionário inválido para esta empresa.");

    const [ins] = await conn.query(
      `INSERT INTO folhas_funcionarios
       (empresa_id, folha_id, funcionario_id, horas_normais, he50_horas, he100_horas,
        valor_base, valor_he50, valor_he100, descontos, proventos, total_liquido, inconsistencias)
       VALUES (?, ?, ?, 0,0,0, 0,0,0, 0,0,0, 0)`,
      [folha.empresa_id, folha.id, funcionarioId]
    );

    await conn.commit();
    res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    await conn.rollback();
    res.status(400).json({ ok: false, error: e.message || "Falha ao incluir funcionário." });
  } finally {
    conn.release();
  }
});

/** RECÁLCULO */
router.post("/folhas/:folhaId/funcionarios/recalcular", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const { from, to } = monthRange(folha.competencia);
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (!ids.length) {
      const [all] = await pool.query(
        `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND empresa_id = ?`,
        [folha.id, folha.empresa_id]
      );
      ids = all.map((r) => r.id);
    }
    if (!ids.length) return res.json({ ok: true, count: 0 });

    // dados folha_funcionarios + funcionarios
    const [rows] = await conn.query(
      `
      SELECT ff.id, ff.funcionario_id, f.regime, f.salario_base, f.valor_hora
        FROM folhas_funcionarios ff
        JOIN funcionarios f ON f.id = ff.funcionario_id AND f.empresa_id = ff.empresa_id
       WHERE ff.id IN (${ids.map(() => "?").join(",")})
         AND ff.folha_id = ? AND ff.empresa_id = ?
      `,
      [...ids, folha.id, folha.empresa_id]
    );
    const funcIds = [...new Set(rows.map((r) => r.funcionario_id))];
    if (!funcIds.length) throw new Error("Funcionários não encontrados.");

    const [apont] = await conn.query(
      `
      SELECT funcionario_id, data, turno_ordem, entrada, saida, DAYOFWEEK(data) AS dow
        FROM apontamentos
       WHERE empresa_id = ?
         AND funcionario_id IN (${funcIds.map(() => "?").join(",")})
         AND data BETWEEN ? AND ?
         AND UPPER(origem) <> 'INVALIDADA'
       ORDER BY funcionario_id, data, turno_ordem, entrada
      `,
      [folha.empresa_id, ...funcIds, from, to]
    );

    const mins = (t) => {
      if (!t) return 0;
      const [h, m] = String(t).split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    const totals = new Map(); // funcId -> {norm: min, he50: min, he100: min}
    for (const r of apont) {
      const id = r.funcionario_id;
      const dur = Math.max(0, mins(r.saida) - mins(r.entrada));
      if (!totals.has(id)) totals.set(id, { norm: 0, he50: 0, he100: 0 });
      const t = totals.get(id);
      if (r.dow === 1) {
        t.he100 += dur;
      } else {
        const norm = Math.min(dur, 8 * 60);
        const extra = Math.max(dur - 8 * 60, 0);
        t.norm += norm;
        t.he50 += extra;
      }
      totals.set(id, t);
    }

    await conn.beginTransaction();
    const results = [];
    for (const r of rows) {
      const mins = totals.get(r.funcionario_id) || { norm: 0, he50: 0, he100: 0 };
      const horas_normais = round2(mins.norm / 60);
      const he50_horas = round2(mins.he50 / 60);
      const he100_horas = round2(mins.he100 / 60);
      const vHora = r.valor_hora || (r.salario_base ? r.salario_base / 220 : 0);
      const regime = (r.regime || "MENSALISTA").toUpperCase();

      let valor_base = 0;
      if (regime === "MENSALISTA") valor_base = r.salario_base || 0;
      else valor_base = vHora * horas_normais;

      const valor_he50 = vHora * he50_horas * 1.5;
      const valor_he100 = vHora * he100_horas * 2.0;
      const proventos = valor_base + valor_he50 + valor_he100;
      const descontos = 0;
      const total_liquido = proventos - descontos;

      await conn.query(
        `UPDATE folhas_funcionarios
            SET horas_normais=?, he50_horas=?, he100_horas=?,
                valor_base=?, valor_he50=?, valor_he100=?,
                proventos=?, descontos=?, total_liquido=?, inconsistencias=0
          WHERE id=?`,
        [
          horas_normais,
          he50_horas,
          he100_horas,
          round2(valor_base),
          round2(valor_he50),
          round2(valor_he100),
          round2(proventos),
          round2(descontos),
          round2(total_liquido),
          r.id,
        ]
      );
      results.push({
        id: r.id,
        funcionario_id: r.funcionario_id,
        horas_normais,
        he50_horas,
        he100_horas,
        valor_base,
        valor_he50,
        valor_he100,
        total_liquido,
      });
    }

    await conn.commit();
    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    await conn.rollback();
    console.error("RECALC_ERR", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao recalcular." });
  } finally {
    conn.release();
  }
});

export default router;