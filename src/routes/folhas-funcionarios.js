// src/routes/folhas-funcionarios.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ======================= helpers ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => { const s = norm(v); return s.length ? s : null; };

/** Aceita "YYYY-MM", "YYYY-MM-DD" e nomes PT-BR -> retorna "YYYY-MM" */
function toYM(input) {
  const s = norm(input).toLowerCase();
  if (!s) return null;
  const mIso = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (mIso) return `${mIso[1]}-${mIso[2]}`;
  const meses = {
    janeiro:"01", fevereiro:"02", março:"03", marco:"03", abril:"04", maio:"05", junho:"06",
    julho:"07", agosto:"08", setembro:"09", outubro:"10", novembro:"11", dezembro:"12"
  };
  const mBr = s.match(
    /(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro).*?(\d{4})/i
  );
  if (mBr) return `${mBr[2]}-${meses[mBr[1].toLowerCase()]}`;
  return null;
}

const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function getUserRoles(userId) {
  // OBS: usuarios_perfis é por empresa; aqui coletamos perfis de qualquer empresa
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => String(r.perfil || "").toLowerCase());
}
function isDev(roles = []) {
  return roles.map((r) => String(r).toLowerCase()).includes("desenvolvedor");
}
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

async function ensureFolhaFuncionarioScope(userId, ffId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Acesso negado (sem empresa vinculada).");

  const [[row]] = await pool.query(
    `SELECT ff.empresa_id
       FROM folhas_funcionarios ff
      WHERE ff.id = ?
      LIMIT 1`,
    [ffId]
  );
  if (!row) throw new Error("Registro não encontrado.");
  if (!empresas.includes(Number(row.empresa_id))) throw new Error("Recurso fora do escopo do usuário.");
  return true;
}

/* ======================= rotas ======================= */

router.use(requireAuth);

/**
 * GET /api/folhas-funcionarios?from=YYYY-MM&to=YYYY-MM&funcionario_id=&q=&scope=mine
 */
router.get("/folhas-funcionarios", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const scope = String(req.query.scope || "mine").toLowerCase();

    const from = toYM(req.query.from);
    const to   = toYM(req.query.to);
    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const q = normStr(req.query.q);

    const where = [];
    const params = [];

    // escopo por empresa
    if (!dev || scope !== "all") {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length) return res.json({ ok: true, items: [], scope: "mine" });
      where.push(`f.empresa_id IN (${empresas.map(() => "?").join(",")})`);
      params.push(...empresas);
    }

    if (from) { where.push(`f.competencia >= ?`); params.push(from); }
    if (to)   { where.push(`f.competencia <= ?`); params.push(to);   }
    if (funcionarioId) { where.push(`ff.funcionario_id = ?`); params.push(funcionarioId); }
    if (q) {
      where.push(`(
        CAST(ff.id AS CHAR) LIKE CONCAT('%',?,'%')
        OR UPPER(COALESCE(p.nome, CONCAT('#', fu.id))) LIKE UPPER(CONCAT('%',?,'%'))
        OR f.competencia LIKE CONCAT('%',?,'%')
      )`);
      params.push(q, q, q);
    }

    const [rows] = await pool.query(
      `SELECT
          ff.id,
          ff.folha_id,
          ff.funcionario_id,
          f.competencia,
          COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
          ff.horas_normais, ff.he50_horas, ff.he100_horas,
          ff.valor_base, ff.valor_he50, ff.valor_he100,
          ff.descontos, ff.proventos, ff.total_liquido,
          ff.inconsistencias
        FROM folhas_funcionarios ff
        JOIN folhas f           ON f.id = ff.folha_id
        JOIN funcionarios fu    ON fu.id = ff.funcionario_id
        LEFT JOIN pessoas p     ON p.id = fu.pessoa_id
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY f.competencia DESC, ff.id DESC`,
      params
    );

    return res.json({ ok: true, items: rows, scope: dev && scope === "all" ? "all" : "mine" });
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar lançamentos." });
  }
});

/**
 * GET /api/folhas-funcionarios/:id
 */
router.get("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScope(req.userId, id);

    const [[row]] = await pool.query(
      `SELECT
          ff.id,
          ff.folha_id,
          ff.funcionario_id,
          f.competencia,
          COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
          ff.horas_normais, ff.he50_horas, ff.he100_horas,
          ff.valor_base, ff.valor_he50, ff.valor_he100,
          ff.descontos, ff.proventos, ff.total_liquido,
          ff.inconsistencias
        FROM folhas_funcionarios ff
        JOIN folhas f        ON f.id = ff.folha_id
        JOIN funcionarios fu ON fu.id = ff.funcionario_id
        LEFT JOIN pessoas p  ON p.id = fu.pessoa_id
       WHERE ff.id = ?
       LIMIT 1`,
      [id]
    );

    if (!row) return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    return res.json({ ok: true, item: row });
  } catch (e) {
    console.error("FF_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao obter registro." });
  }
});

/**
 * POST /api/folhas-funcionarios
 * - Se não vier folha_id, localiza pela competência dentro do escopo do usuário.
 * - Preenche empresa_id a partir da folha.
 */
router.post("/folhas-funcionarios", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    let { folha_id, competencia, funcionario_id } = req.body || {};
    folha_id = folha_id ? Number(folha_id) : null;
    competencia = toYM(competencia);
    funcionario_id = Number(funcionario_id);

    if (!funcionario_id) {
      return res.status(400).json({ ok: false, error: "Informe funcionario_id." });
    }
    if (!competencia && !folha_id) {
      return res.status(400).json({ ok: false, error: "Informe competencia (YYYY-MM) ou folha_id." });
    }

    // resolver folha_id se não veio
    if (!folha_id) {
      let where = `f.competencia = ?`;
      const params = [competencia];

      if (!dev) {
        const empresas = await getUserEmpresaIds(req.userId);
        if (!empresas.length) {
          return res.status(403).json({ ok: false, error: "Usuário sem empresa vinculada." });
        }
        where += ` AND f.empresa_id IN (${empresas.map(() => "?").join(",")})`;
        params.push(...empresas);
      }

      const [[frow]] = await pool.query(
        `SELECT f.id, f.empresa_id FROM folhas f WHERE ${where} ORDER BY f.id DESC LIMIT 1`,
        params
      );
      if (!frow) {
        // mensagem explícita para depuração de front
        return res.status(404).json({
          ok: false,
          error: `Folha não encontrada para a competência ${competencia} dentro do seu escopo.`,
        });
      }
      folha_id = Number(frow.id);
    } else {
      // validar escopo da folha informada
      if (!dev) {
        const empresas = await getUserEmpresaIds(req.userId);
        if (!empresas.length) return res.status(403).json({ ok: false, error: "Usuário sem empresa vinculada." });
        const [[chk]] = await pool.query(`SELECT empresa_id FROM folhas WHERE id = ? LIMIT 1`, [folha_id]);
        if (!chk) return res.status(404).json({ ok: false, error: "Folha inexistente." });
        if (!empresas.includes(Number(chk.empresa_id))) {
          return res.status(403).json({ ok: false, error: "Folha fora do escopo do usuário." });
        }
      }
    }

    // empresa da folha (obrigatório em folhas_funcionarios)
    const [[folhaInfo]] = await pool.query(
      `SELECT empresa_id FROM folhas WHERE id = ? LIMIT 1`,
      [folha_id]
    );
    if (!folhaInfo) return res.status(404).json({ ok: false, error: "Folha inexistente." });
    const empresa_id = Number(folhaInfo.empresa_id);

    const payload = {
      empresa_id,
      folha_id,
      funcionario_id,
      horas_normais:  numOrNull(req.body?.horas_normais),
      he50_horas:     numOrNull(req.body?.he50_horas),
      he100_horas:    numOrNull(req.body?.he100_horas),
      valor_base:     numOrNull(req.body?.valor_base),
      valor_he50:     numOrNull(req.body?.valor_he50),
      valor_he100:    numOrNull(req.body?.valor_he100),
      descontos:      numOrNull(req.body?.descontos),
      proventos:      numOrNull(req.body?.proventos),
      total_liquido:  numOrNull(req.body?.total_liquido),
      inconsistencias: Number(req.body?.inconsistencias || 0),
    };

    const [ins] = await pool.query(
      `INSERT INTO folhas_funcionarios
        (empresa_id, folha_id, funcionario_id, horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100, descontos, proventos, total_liquido, inconsistencias)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        payload.empresa_id,
        payload.folha_id, payload.funcionario_id,
        payload.horas_normais, payload.he50_horas, payload.he100_horas,
        payload.valor_base, payload.valor_he50, payload.valor_he100,
        payload.descontos, payload.proventos, payload.total_liquido,
        payload.inconsistencias
      ]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("FF_CREATE_ERR", e);
    // se vier "Column 'folha_id' cannot be null" fica mais claro pro cliente
    const msg = /cannot be null/i.test(e?.message || "")
      ? "Falha ao criar: 'folha_id' ficou nulo após resolução. Verifique a competência enviada."
      : (e.message || "Falha ao criar lançamento.");
    return res.status(400).json({ ok: false, error: msg });
  }
});

/**
 * PUT /api/folhas-funcionarios/:id
 */
router.put("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScope(req.userId, id);

    const sets = [];
    const params = [];

    if (req.body?.funcionario_id !== undefined) { sets.push("funcionario_id = ?"); params.push(Number(req.body.funcionario_id)); }
    if (req.body?.horas_normais !== undefined)  { sets.push("horas_normais = ?");  params.push(numOrNull(req.body.horas_normais)); }
    if (req.body?.he50_horas !== undefined)     { sets.push("he50_horas = ?");     params.push(numOrNull(req.body.he50_horas)); }
    if (req.body?.he100_horas !== undefined)    { sets.push("he100_horas = ?");    params.push(numOrNull(req.body.he100_horas)); }
    if (req.body?.valor_base !== undefined)     { sets.push("valor_base = ?");     params.push(numOrNull(req.body.valor_base)); }
    if (req.body?.valor_he50 !== undefined)     { sets.push("valor_he50 = ?");     params.push(numOrNull(req.body.valor_he50)); }
    if (req.body?.valor_he100 !== undefined)    { sets.push("valor_he100 = ?");    params.push(numOrNull(req.body.valor_he100)); }
    if (req.body?.descontos !== undefined)      { sets.push("descontos = ?");      params.push(numOrNull(req.body.descontos)); }
    if (req.body?.proventos !== undefined)      { sets.push("proventos = ?");      params.push(numOrNull(req.body.proventos)); }
    if (req.body?.total_liquido !== undefined)  { sets.push("total_liquido = ?");  params.push(numOrNull(req.body.total_liquido)); }
    if (req.body?.inconsistencias !== undefined){ sets.push("inconsistencias = ?");params.push(Number(req.body.inconsistencias || 0)); }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);
    await pool.query(`UPDATE folhas_funcionarios SET ${sets.join(", ")} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (e) {
    console.error("FF_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar lançamento." });
  }
});

/**
 * DELETE /api/folhas-funcionarios/:id
 */
router.delete("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScope(req.userId, id);

    await pool.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);
    return res.json({ ok: true });
  } catch (e) {
    if (e?.code === "ER_ROW_IS_REFERENCED_2" || e?.errno === 1451) {
      return res.status(409).json({ ok: false, error: "Não é possível excluir: registro referenciado." });
    }
    console.error("FF_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir lançamento." });
  }
});

export default router;