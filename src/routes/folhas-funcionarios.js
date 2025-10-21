// src/routes/folhas-funcionarios.js
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

/* ======================= HELPERS ======================= */
const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Empresas do usuário autenticado (apenas ativas)
async function getUserEmpresaIds(userId) {
  if (!userId) return [];
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => Number(r.empresa_id));
}

/* ======================= MIDDLEWARES ======================= */
router.use(requireAuth, (req, _res, next) => {
  if (!req.userId && req.user?.id) req.userId = req.user.id;
  next();
});

/* ======================= ROTAS ======================= */

/**
 * GET /api/folhas-funcionarios
 * Lista lançamentos das empresas do usuário (sem exigir folha_id).
 * Filtros opcionais: folha_id, funcionario_id, q (nome/id/competência).
 * Retorna meta.folhas (distintas) para o front popular filtros sem nova chamada.
 */
router.get("/", async (req, res) => {
  try {
    const userId = req.userId;
    const { folha_id, funcionario_id, q } = req.query || {};
    console.log("🔍 FF_LIST - user:", userId, "| filtros =>", { folha_id, funcionario_id, q });

    const empresasUser = await getUserEmpresaIds(userId);
    console.log("🔍 FF_LIST - empresas:", empresasUser);

    if (!empresasUser.length) {
      return res.json({ ok: true, items: [], total: 0, meta: { folhas: [] } });
    }

    // -------- WHERE dinâmico para itens --------
    const where = [`ff.empresa_id IN (?)`];
    const params = [empresasUser];

    if (folha_id) {
      where.push(`ff.folha_id = ?`);
      params.push(Number(folha_id));
    }
    if (funcionario_id) {
      where.push(`ff.funcionario_id = ?`);
      params.push(Number(funcionario_id));
    }
    if (q) {
      // Busca por nome (LIKE), por id exato (fu.id) e por competência (YYYY-MM)
      where.push(`(p.nome LIKE ? OR fu.id = ? OR f.competencia LIKE ?)`);
      params.push(`%${q}%`, Number(q) || 0, `%${q}%`);
    }

    const [rows] = await pool.query(
      `SELECT
         ff.id, ff.folha_id, ff.funcionario_id, ff.empresa_id,
         f.competencia,
         COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
         ff.horas_normais, ff.he50_horas, ff.he100_horas,
         ff.valor_base, ff.valor_he50, ff.valor_he100,
         ff.descontos, ff.proventos, ff.total_liquido,
         ff.inconsistencias
       FROM folhas_funcionarios ff
       JOIN folhas        f  ON f.id  = ff.folha_id
       JOIN funcionarios  fu ON fu.id = ff.funcionario_id
       LEFT JOIN pessoas  p  ON p.id  = fu.pessoa_id
       WHERE ${where.join(" AND ")}
       ORDER BY f.competencia DESC, ff.id DESC`,
      params
    );

    // -------- Folhas distintas (apenas das empresas do usuário) --------
    // Usa ff para garantir que são folhas "com movimento" para esse usuário,
    // e junta com f para trazer competencia e ordenar decentemente.
    const [folhasDistinct] = await pool.query(
      `SELECT DISTINCT f.id, f.competencia
         FROM folhas_funcionarios ff
         JOIN folhas f ON f.id = ff.folha_id
        WHERE ff.empresa_id IN (?)
        ORDER BY f.competencia DESC, f.id DESC`,
      [empresasUser]
    );

    console.log("🔍 FF_LIST - encontrados:", rows.length, "| folhas disponíveis:", folhasDistinct.length);

    return res.json({
      ok: true,
      items: rows,
      total: rows.length,
      meta: {
        folhas: folhasDistinct, // [{id, competencia}]
      },
    });
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({
      ok: false,
      error: e.message || "Falha ao listar lançamentos.",
    });
  }
});

/** GET /api/folhas-funcionarios/:id */
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.userId;

    const empresasUser = await getUserEmpresaIds(userId);
    const [[row]] = await pool.query(
      `SELECT
          ff.id, ff.folha_id, ff.funcionario_id, ff.empresa_id,
          f.competencia,
          COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
          ff.horas_normais, ff.he50_horas, ff.he100_horas,
          ff.valor_base, ff.valor_he50, ff.valor_he100,
          ff.descontos, ff.proventos, ff.total_liquido,
          ff.inconsistencias
        FROM folhas_funcionarios ff
        JOIN folhas        f  ON f.id  = ff.folha_id
        JOIN funcionarios  fu ON fu.id = ff.funcionario_id
        LEFT JOIN pessoas  p  ON p.id  = fu.pessoa_id
       WHERE ff.id = ? AND ff.empresa_id IN (?)
       LIMIT 1`,
      [id, empresasUser]
    );

    if (!row) {
      return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    }
    return res.json({ ok: true, item: row });
  } catch (e) {
    console.error("FF_GET_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao obter registro." });
  }
});

/**
 * POST /api/folhas-funcionarios
 * Cria um lançamento (folha_id e funcionario_id obrigatórios).
 */
router.post("/", async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const userId = req.userId;
    const { folha_id, funcionario_id } = req.body || {};

    if (!folha_id) throw new Error("Criação: 'folha_id' é obrigatório.");
    if (!funcionario_id) throw new Error("Criação: 'funcionario_id' é obrigatório.");

    // Folha precisa pertencer às empresas do usuário
    const empresasUser = await getUserEmpresaIds(userId);
    const [[folha]] = await conn.query(
      `SELECT empresa_id, competencia
         FROM folhas
        WHERE id = ? AND empresa_id IN (?)
        LIMIT 1`,
      [folha_id, empresasUser]
    );
    if (!folha) throw new Error("Folha não encontrada ou sem acesso.");

    // Funcionário precisa pertencer à mesma empresa
    const [[funcionario]] = await conn.query(
      `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
      [funcionario_id]
    );
    if (!funcionario) throw new Error("Funcionário não encontrado.");
    if (Number(funcionario.empresa_id) !== Number(folha.empresa_id)) {
      throw new Error("Funcionário não pertence à empresa da folha.");
    }

    // Evitar duplicidade (funcionário x folha)
    const [[dup]] = await conn.query(
      `SELECT id FROM folhas_funcionarios
        WHERE folha_id = ? AND funcionario_id = ?
        LIMIT 1`,
      [folha_id, funcionario_id]
    );
    if (dup) throw new Error("Já existe um lançamento para este funcionário nesta folha.");

    // Monta payload
    const payload = {
      empresa_id: folha.empresa_id,
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

    // Calcula total quando não informado
    if (payload.total_liquido == null) {
      payload.total_liquido =
        (payload.valor_base || 0) +
        (payload.valor_he50 || 0) +
        (payload.valor_he100 || 0) +
        (payload.proventos || 0) -
        (payload.descontos || 0);
    }

    const [ins] = await conn.query(
      `INSERT INTO folhas_funcionarios
        (empresa_id, folha_id, funcionario_id,
         horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100,
         descontos, proventos, total_liquido, inconsistencias)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        payload.empresa_id, payload.folha_id, payload.funcionario_id,
        payload.horas_normais, payload.he50_horas, payload.he100_horas,
        payload.valor_base, payload.valor_he50, payload.valor_he100,
        payload.descontos, payload.proventos, payload.total_liquido,
        payload.inconsistencias,
      ]
    );

    await conn.commit();

    return res.json({
      ok: true,
      id: ins.insertId,
      folha_id,
      competencia: folha.competencia,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    return res.status(400).json({
      ok: false,
      error: e.message || "Falha ao criar lançamento.",
    });
  } finally {
    if (conn) conn.release?.();
  }
});

/** PUT /api/folhas-funcionarios/:id */
router.put("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
       const userId = req.userId;

    // Verifica acesso ao registro
    const empresasUser = await getUserEmpresaIds(userId);
    const [[exists]] = await pool.query(
      `SELECT id FROM folhas_funcionarios WHERE id = ? AND empresa_id IN (?)`,
      [id, empresasUser]
    );
    if (!exists) throw new Error("Registro não encontrado ou sem acesso.");

    // Campos atualizáveis
    const sets = [];
    const params = [];

    if (req.body?.horas_normais !== undefined) { sets.push("horas_normais = ?"); params.push(numOrNull(req.body.horas_normais)); }
    if (req.body?.he50_horas !== undefined)    { sets.push("he50_horas = ?");    params.push(numOrNull(req.body.he50_horas)); }
    if (req.body?.he100_horas !== undefined)   { sets.push("he100_horas = ?");   params.push(numOrNull(req.body.he100_horas)); }
    if (req.body?.valor_base !== undefined)    { sets.push("valor_base = ?");    params.push(numOrNull(req.body.valor_base)); }
    if (req.body?.valor_he50 !== undefined)    { sets.push("valor_he50 = ?");    params.push(numOrNull(req.body.valor_he50)); }
    if (req.body?.valor_he100 !== undefined)   { sets.push("valor_he100 = ?");   params.push(numOrNull(req.body.valor_he100)); }
    if (req.body?.descontos !== undefined)     { sets.push("descontos = ?");     params.push(numOrNull(req.body.descontos)); }
    if (req.body?.proventos !== undefined)     { sets.push("proventos = ?");     params.push(numOrNull(req.body.proventos)); }
    if (req.body?.total_liquido !== undefined) { sets.push("total_liquido = ?"); params.push(numOrNull(req.body.total_liquido)); }
    if (req.body?.inconsistencias !== undefined) {
      sets.push("inconsistencias = ?");
      params.push(Number(req.body.inconsistencias || 0));
    }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);
    await pool.query(`UPDATE folhas_funcionarios SET ${sets.join(", ")} WHERE id = ?`, params);
    return res.json({ ok: true });
  } catch (e) {
    console.error("FF_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar lançamento." });
  }
});

/** DELETE /api/folhas-funcionarios/:id */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const userId = req.userId;

    const empresasUser = await getUserEmpresaIds(userId);
    const [[exists]] = await pool.query(
      `SELECT id FROM folhas_funcionarios WHERE id = ? AND empresa_id IN (?)`,
      [id, empresasUser]
    );
    if (!exists) throw new Error("Registro não encontrado ou sem acesso.");

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
