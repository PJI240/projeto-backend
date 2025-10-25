// src/routes/folhas-funcionarios.js
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

/** Folha dentro do escopo do usuário */
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

/** Converte competência YYYY-MM → {from:'YYYY-MM-DD', to:'YYYY-MM-DD'} (UTC) */
function monthRange(competenciaYM) {
  const [y, m] = String(competenciaYM).split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0));
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: iso(from), to: iso(to) };
}
const DAILY_NORM_MIN = 8 * 60;
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* ======================= ROTAS (escopo /api) ======================= */

router.use(requireAuth);

/** GET /api/folhas */
router.get("/folhas", async (req, res) => {
  try {
    const userId = req.user.id;
    const dev = isDev(await getUserRoles(userId));

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
      SELECT
        ff.id, ff.empresa_id, ff.folha_id, ff.funcionario_id,
        ff.horas_normais, ff.he50_horas, ff.he100_horas,
        ff.valor_base, ff.valor_he50, ff.valor_he100,
        ff.descontos, ff.proventos, ff.total_liquido,
        ff.inconsistencias,
        p.nome, p.cpf
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
           SELECT funcionario_id
             FROM folhas_funcionarios
            WHERE folha_id = ?
              AND empresa_id = ?
         )
         ${q ? "AND (p.nome LIKE ? OR REPLACE(REPLACE(REPLACE(p.cpf,'.',''),'-',''),'/','') LIKE REPLACE(REPLACE(REPLACE(?,'.',''),'-',''),'/',''))" : ""}
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

/** POST /api/folhas/:folhaId/funcionarios */
router.post("/folhas/:folhaId/funcionarios", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const funcionarioId = Number(req.body?.funcionario_id);
    if (!funcionarioId) return res.status(400).json({ ok: false, error: "Informe funcionario_id." });

    if (String(folha.status || "").toUpperCase() !== "ABERTA") {
      return res.status(409).json({ ok: false, error: "Folha não permite novos lançamentos." });
    }

    await conn.beginTransaction();

    const [[fok]] = await conn.query(
      `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? AND ativo = 1 LIMIT 1`,
      [funcionarioId, folha.empresa_id]
    );
    if (!fok) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Funcionário inválido para esta empresa." });
    }

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

/** DELETE /api/folhas/:folhaId/funcionarios/:id */
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

/* ======================= RECÁLCULO (espelhando /apontamentos) =======================
   - Busca eventos (1 linha por evento) e PAREIA ENTRADA→SAIDA por funcionário+data+turno
   - Ignora status_tratamento = INVALIDADA e origem = INVALIDADA
   - Domingo (DAYOFWEEK=1): tudo HE100
   - Seg–Sáb: até 8h/dia normais, excedente HE50
   - valor_hora = funcionarios.valor_hora || (salario_base/220 se houver)
   - Mensalista: valor_base = salario_base; Horista/Diarista: valor_base = valor_hora * horas_normais
*/
router.post("/folhas/:folhaId/funcionarios/recalcular", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.user.id, req.params.folhaId);
    const { from, to } = monthRange(folha.competencia);

    // IDs alvo
    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) {
      const [all] = await pool.query(
        `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND empresa_id = ?`,
        [folha.id, folha.empresa_id]
      );
      ids = all.map((r) => r.id);
    }
    if (!ids.length) return res.json({ ok: true, count: 0, results: [] });

    // Metadados dos lançamentos e pessoas
    const [ffRows] = await conn.query(
      `
      SELECT ff.id, ff.funcionario_id,
             f.regime, f.salario_base, f.valor_hora
        FROM folhas_funcionarios ff
        JOIN funcionarios f
          ON f.id = ff.funcionario_id AND f.empresa_id = ff.empresa_id
       WHERE ff.id IN (${ids.map(() => "?").join(",")})
         AND ff.folha_id = ?
         AND ff.empresa_id = ?
      `,
      [...ids, folha.id, folha.empresa_id]
    );
    if (!ffRows.length) return res.status(404).json({ ok: false, error: "Nenhum lançamento encontrado." });

    const funcIds = [...new Set(ffRows.map((r) => r.funcionario_id))];

    // Eventos conforme /api/apontamentos (1 linha por evento)
    const [events] = await conn.query(
      `
      SELECT funcionario_id,
             DATE_FORMAT(data, '%Y-%m-%d') AS data,
             turno_ordem,
             evento,           -- 'ENTRADA' | 'SAIDA'
             horario,          -- 'HH:MM'
             DAYOFWEEK(data) AS dow
        FROM apontamentos
       WHERE empresa_id = ?
         AND data BETWEEN ? AND ?
         AND funcionario_id IN (${funcIds.map(() => "?").join(",")})
         AND UPPER(COALESCE(status_tratamento,'VALIDA')) <> 'INVALIDADA'
         AND UPPER(COALESCE(origem,'APONTADO')) <> 'INVALIDADA'
       ORDER BY funcionario_id, data, turno_ordem, horario
      `,
      [folha.empresa_id, from, to, ...funcIds]
    );

    // === Pareamento ENTRADA→SAIDA por chave (func+data+turno)
    const key = (r) => `${r.funcionario_id}|${r.data}|${r.turno_ordem}`;
    const buckets = new Map();
    for (const ev of events) {
      const k = key(ev);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(ev);
    }

    const mins = (hhmm) => {
      if (!hhmm) return 0;
      const [h, m] = String(hhmm).split(":").map(Number);
      return (h || 0) * 60 + (m || 0);
    };

    // minutos por funcionário por dia
    const dayMinByFunc = new Map(); // Map(funcId -> Map(date -> {dow, min}))
    for (const [, arr] of buckets.entries()) {
      arr.sort((a, b) => (a.horario || "").localeCompare(b.horario || ""));
      for (let i = 0; i < arr.length; i++) {
        const a = arr[i];
        if (String(a.evento).toUpperCase() !== "ENTRADA") continue;
        const b = arr[i + 1];
        if (b && String(b.evento).toUpperCase() === "SAIDA") {
          const dur = Math.max(0, mins(b.horario) - mins(a.horario)); // sem virada de dia (igual relatório)
          if (!dayMinByFunc.has(a.funcionario_id)) dayMinByFunc.set(a.funcionario_id, new Map());
          const dmap = dayMinByFunc.get(a.funcionario_id);
          const cur = dmap.get(a.data) || { dow: a.dow, min: 0 };
          cur.min += dur;
          dmap.set(a.data, cur);
          i++; // consome a SAIDA
        } else {
          // ENTRADA sem SAÍDA → ignora (duração 0), igual ao relatório
        }
      }
    }

    // Consolida: normal / HE50 / HE100
    const normMin = new Map(), he50Min = new Map(), he100Min = new Map();
    for (const [fid, dmap] of dayMinByFunc.entries()) {
      for (const [, { dow, min }] of dmap.entries()) {
        if (dow === 1) { // Domingo
          he100Min.set(fid, (he100Min.get(fid) || 0) + min);
        } else {
          const n = Math.min(min, DAILY_NORM_MIN);
          const e = Math.max(min - DAILY_NORM_MIN, 0);
          normMin.set(fid, (normMin.get(fid) || 0) + n);
          he50Min.set(fid, (he50Min.get(fid) || 0) + e);
        }
      }
    }

    await conn.beginTransaction();
    const results = [];
    for (const meta of ffRows) {
      const fid = meta.funcionario_id;
      const hNorm  = round2((normMin.get(fid)  || 0) / 60);
      const hHe50  = round2((he50Min.get(fid)  || 0) / 60);
      const hHe100 = round2((he100Min.get(fid) || 0) / 60);

      const vHora = Number(meta.valor_hora || (meta.salario_base ? meta.salario_base / 220 : 0) || 0);
      const regime = String(meta.regime || "MENSALISTA").toUpperCase();

      const valor_base  = round2(regime === "MENSALISTA" ? (meta.salario_base || 0) : vHora * hNorm);
      const valor_he50  = round2(vHora * 1.5 * hHe50);
      const valor_he100 = round2(vHora * 2.0 * hHe100);

      const proventos     = round2(valor_base + valor_he50 + valor_he100);
      const descontos     = 0;
      const total_liquido = round2(proventos - descontos);

      await conn.query(
        `UPDATE folhas_funcionarios
            SET horas_normais = ?,
                he50_horas    = ?,
                he100_horas   = ?,
                valor_base    = ?,
                valor_he50    = ?,
                valor_he100   = ?,
                proventos     = ?,
                descontos     = ?,
                total_liquido = ?,
                inconsistencias = 0
          WHERE id = ?`,
        [hNorm, hHe50, hHe100, valor_base, valor_he50, valor_he100, proventos, descontos, total_liquido, meta.id]
      );

      results.push({
        id: meta.id,
        funcionario_id: fid,
        horas_normais: hNorm,
        he50_horas: hHe50,
        he100_horas: hHe100,
        valor_base,
        valor_he50,
        valor_he100,
        total_liquido,
      });
    }

    await conn.commit();
    res.json({ ok: true, count: results.length, period: { from, to }, results });
  } catch (e) {
    await (conn?.rollback?.());
    console.error("RECALC_ERR", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao recalcular." });
  } finally {
    conn.release();
  }
});

export default router;