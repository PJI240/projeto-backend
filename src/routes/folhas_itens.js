// src/routes/folhas_itens.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ===================== helpers genéricos ===================== */

function normStr(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}
function toDateOrNull(s) {
  const v = normStr(s);
  if (!v) return null;
  // aceita "YYYY-MM-DD" ou "DD/MM/YYYY"
  const mIso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mBr  = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (mIso) return v;
  if (mBr)  return `${mBr[3]}-${mBr[2]}-${mBr[1]}`;
  return null;
}
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ===================== helpers auth/scope ===================== */

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
function requireAuth(req, _res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return next(new Error("Não autenticado."));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    return next();
  } catch {
    return next(new Error("Sessão inválida."));
  }
}

/** Retorna empresa_id da linha de folha (folha_funcionario_id) */
async function getEmpresaIdByFolhaFuncionarioId(folhaFuncId) {
  const [[row]] = await pool.query(
    `SELECT f.empresa_id
       FROM folhas_funcionarios ff
       JOIN folhas f ON f.id = ff.folha_id
      WHERE ff.id = ?
      LIMIT 1`,
    [folhaFuncId]
  );
  return row?.empresa_id ?? null;
}

/** Garante que o usuário pode acessar a folha_funcionario (pela empresa da folha) */
async function ensureCanAccessFolhaFuncionario(userId, folhaFuncId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresasUser = await getUserEmpresaIds(userId);
  if (!empresasUser.length) throw new Error("Acesso negado (sem empresa vinculada).");

  const empresaId = await getEmpresaIdByFolhaFuncionarioId(folhaFuncId);
  if (!empresaId) throw new Error("Linha de folha não encontrada.");
  if (!empresasUser.includes(Number(empresaId))) throw new Error("Recurso fora do escopo do usuário.");

  return true;
}

/** Garante que o usuário pode acessar o item, olhando empresa do item */
async function ensureCanAccessItem(userId, itemId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresasUser = await getUserEmpresaIds(userId);
  if (!empresasUser.length) throw new Error("Acesso negado (sem empresa vinculada).");

  const [[row]] = await pool.query(
    `SELECT empresa_id FROM folhas_itens WHERE id = ? LIMIT 1`,
    [itemId]
  );
  if (!row) throw new Error("Item não encontrado.");
  if (!empresasUser.includes(Number(row.empresa_id))) throw new Error("Recurso fora do escopo do usuário.");
  return true;
}

/* =========================================================
   A PARTIR DAQUI: rotas protegidas
   ========================================================= */

router.use((req, res, next) => {
  requireAuth(req, res, (err) => {
    if (err) return res.status(401).json({ ok: false, error: err.message });
    next();
  });
});

/**
 * GET /api/folhas?scope=mine
 * - dev: pode ver todas; demais: somente empresas vinculadas
 */
router.get("/folhas", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    if (dev) {
      const [rows] = await pool.query(
        `SELECT id, empresa_id, competencia, status
           FROM folhas
          ORDER BY competencia DESC, id DESC`
      );
      return res.json({ ok: true, folhas: rows, scope: "all" });
    }

    const empresas = await getUserEmpresaIds(req.userId);
    if (!empresas.length) return res.json({ ok: true, folhas: [], scope: "mine" });

    const [rows] = await pool.query(
      `SELECT id, empresa_id, competencia, status
         FROM folhas
        WHERE empresa_id IN (${empresas.map(() => "?").join(",")})
        ORDER BY competencia DESC, id DESC`,
      empresas
    );
    return res.json({ ok: true, folhas: rows, scope: "mine" });
  } catch (e) {
    console.error("FOLHAS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar folhas." });
  }
});

/**
 * GET /api/folhas-funcionarios?folha_id=ID
 * Lista linhas da folha (para popular o select de funcionário).
 */
router.get("/folhas-funcionarios", async (req, res) => {
  try {
    const folhaId = Number(req.query.folha_id);
    if (!folhaId) return res.status(400).json({ ok: false, error: "folha_id é obrigatório." });

    // escopo: folha deve pertencer ao conjunto de empresas do usuário (se não-dev)
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const params = [folhaId];

    let scopeSql = "";
    if (!dev) {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length) return res.json({ ok: true, itens: [] });
      scopeSql = ` AND f.empresa_id IN (${empresas.map(() => "?").join(",")})`;
      params.push(...empresas);
    }

    const [rows] = await pool.query(
      `SELECT
         ff.id,
         ff.folha_id,
         ff.funcionario_id,
         p.nome AS pessoa_nome
       FROM folhas_funcionarios ff
       JOIN funcionarios fu ON fu.id = ff.funcionario_id
       JOIN pessoas p ON p.id = fu.pessoa_id
       JOIN folhas f ON f.id = ff.folha_id
      WHERE ff.folha_id = ?
        ${scopeSql}
      ORDER BY p.nome ASC`,
      params
    );

    return res.json({ ok: true, itens: rows });
  } catch (e) {
    console.error("FOLHAS_FUNC_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar funcionários da folha." });
  }
});

/**
 * GET /api/folhas-itens
 * Filtros: folha_id, folha_funcionario_id, tipo, q, from, to, limit, offset
 * - "from"/"to" aplicados sobre a competência da folha (YYYY-MM ⇒ usamos CONCAT('-01'))
 */
router.get("/folhas-itens", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const empresasUser = dev ? [] : await getUserEmpresaIds(req.userId);

    const folhaId = req.query.folha_id ? Number(req.query.folha_id) : null;
    const folhaFuncId = req.query.folha_funcionario_id ? Number(req.query.folha_funcionario_id) : null;
    const tipo = normStr(req.query.tipo);
    const q = normStr(req.query.q);
    const from = toDateOrNull(req.query.from);
    const to   = toDateOrNull(req.query.to);

    const limit  = Math.min(500, Math.max(1, Number(req.query.limit || 500)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    const where = [];
    const params = [];

    if (folhaId)     { where.push(`ff.folha_id = ?`); params.push(folhaId); }
    if (folhaFuncId) { where.push(`fi.folha_funcionario_id = ?`); params.push(folhaFuncId); }
    if (tipo && tipo.toLowerCase() !== "todos") { where.push(`UPPER(fi.tipo) = UPPER(?)`); params.push(tipo); }
    if (q) {
      where.push(`(
        UPPER(fi.referencia) LIKE UPPER(CONCAT('%',?,'%')) OR
        UPPER(fi.obs)        LIKE UPPER(CONCAT('%',?,'%')) OR
        UPPER(p.nome)        LIKE UPPER(CONCAT('%',?,'%'))
      )`);
      params.push(q, q, q);
    }
    if (from) { where.push(`DATE(CONCAT(f.competencia,'-01')) >= ?`); params.push(from); }
    if (to)   { where.push(`DATE(CONCAT(f.competencia,'-01')) <= ?`); params.push(to); }

    if (!dev) {
      if (!empresasUser.length) return res.json({ ok: true, itens: [], total: 0, limit, offset });
      where.push(`fi.empresa_id IN (${empresasUser.map(() => "?").join(",")})`);
      params.push(...empresasUser);
    }

    const sqlBase = `
      FROM folhas_itens fi
      JOIN folhas_funcionarios ff ON ff.id = fi.folha_funcionario_id
      JOIN folhas f ON f.id = ff.folha_id
      JOIN funcionarios fu ON fu.id = ff.funcionario_id
      JOIN pessoas p ON p.id = fu.pessoa_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
    `;

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${sqlBase}`, params);

    const [rows] = await pool.query(
      `SELECT
         fi.id, fi.empresa_id, fi.folha_funcionario_id,
         fi.tipo, fi.referencia, fi.quantidade, fi.valor_unit, fi.valor_total, fi.obs,
         p.nome AS funcionario_nome,
         f.competencia
       ${sqlBase}
       ORDER BY f.competencia DESC, fi.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({ ok: true, itens: rows, total, limit, offset });
  } catch (e) {
    console.error("FOLHAS_ITENS_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar itens da folha." });
  }
});

/**
 * POST /api/folhas-itens
 * body: { folha_funcionario_id, tipo, referencia, quantidade, valor_unit, valor_total, obs }
 * - empresa_id é deduzido da folha do registro folha_funcionario
 */
router.post("/folhas-itens", async (req, res) => {
  try {
    const folha_funcionario_id = Number(req.body?.folha_funcionario_id);
    if (!folha_funcionario_id) return res.status(400).json({ ok: false, error: "folha_funcionario_id é obrigatório." });

    await ensureCanAccessFolhaFuncionario(req.userId, folha_funcionario_id);

    const empresa_id = await getEmpresaIdByFolhaFuncionarioId(folha_funcionario_id);
    if (!empresa_id) return res.status(404).json({ ok: false, error: "Folha/empresa não encontrada." });

    const payload = {
      tipo:        normStr(req.body?.tipo),
      referencia:  normStr(req.body?.referencia),
      quantidade:  numOrNull(req.body?.quantidade),
      valor_unit:  numOrNull(req.body?.valor_unit),
      valor_total: numOrNull(req.body?.valor_total),
      obs:         normStr(req.body?.obs),
    };
    if (payload.valor_total == null) {
      const q = payload.quantidade ?? 0;
      const vu = payload.valor_unit ?? 0;
      payload.valor_total = Number(q) * Number(vu);
    }

    const [ins] = await pool.query(
      `INSERT INTO folhas_itens
         (empresa_id, folha_funcionario_id, tipo, referencia, quantidade, valor_unit, valor_total, obs)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        empresa_id, folha_funcionario_id, payload.tipo, payload.referencia,
        payload.quantidade, payload.valor_unit, payload.valor_total, payload.obs
      ]
    );

    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    console.error("FOLHAS_ITENS_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar item." });
  }
});

/**
 * PUT /api/folhas-itens/:id
 * - permite trocar a linha da folha (revalida escopo e recalcula empresa_id)
 */
router.put("/folhas-itens/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    await ensureCanAccessItem(req.userId, id);

    const sets = [];
    const params = [];

    if (req.body?.folha_funcionario_id != null) {
      const novoFF = Number(req.body.folha_funcionario_id);
      await ensureCanAccessFolhaFuncionario(req.userId, novoFF);
      const novaEmp = await getEmpresaIdByFolhaFuncionarioId(novoFF);
      sets.push("folha_funcionario_id = ?"); params.push(novoFF);
      sets.push("empresa_id = ?");           params.push(novaEmp);
    }

    if (req.body?.tipo !== undefined)        { sets.push("tipo = ?");        params.push(normStr(req.body.tipo)); }
    if (req.body?.referencia !== undefined)  { sets.push("referencia = ?");  params.push(normStr(req.body.referencia)); }
    if (req.body?.quantidade !== undefined)  { sets.push("quantidade = ?");  params.push(numOrNull(req.body.quantidade)); }
    if (req.body?.valor_unit !== undefined)  { sets.push("valor_unit = ?");  params.push(numOrNull(req.body.valor_unit)); }
    if (req.body?.valor_total !== undefined) { sets.push("valor_total = ?"); params.push(numOrNull(req.body.valor_total)); }
    if (req.body?.obs !== undefined)         { sets.push("obs = ?");         params.push(normStr(req.body.obs)); }

    if (!sets.length) return res.json({ ok: true, changed: 0 });

    params.push(id);
    await pool.query(`UPDATE folhas_itens SET ${sets.join(", ")} WHERE id = ?`, params);

    return res.json({ ok: true });
  } catch (e) {
    console.error("FOLHAS_ITENS_UPDATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao atualizar item." });
  }
});

/**
 * DELETE /api/folhas-itens/:id
 */
router.delete("/folhas-itens/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    await ensureCanAccessItem(req.userId, id);

    await pool.query(`DELETE FROM folhas_itens WHERE id = ?`, [id]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("FOLHAS_ITENS_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir item." });
  }
});

export default router;