// src/routes/folhas-funcionarios.js
import express from "express";
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = express.Router();

/* ======================= HELPERS ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => {
  const s = norm(v);
  return s.length ? s : null;
};

// "outubro de 2025", "2025-10" ou "2025-10-01" -> "2025-10"
function toYM(input) {
  const s = norm(input).toLowerCase();
  if (!s) return null;
  const mIso = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (mIso) return `${mIso[1]}-${mIso[2]}`;
  const meses = {
    janeiro: "01", fevereiro: "02", março: "03", marco: "03",
    abril: "04", maio: "05", junho: "06", julho: "07",
    agosto: "08", setembro: "09", outubro: "10", novembro: "11", dezembro: "12",
  };
  const mBr = s.match(/(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro).*?(\d{4})/i);
  if (mBr) return `${mBr[2]}-${meses[mBr[1].toLowerCase()]}`;
  return null;
}

const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function getUserRoles(userId) {
  if (!userId) return [];
  const [rows] = await pool.query(
    `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
      WHERE up.usuario_id = ?`,
    [userId]
  );
  return rows.map((r) => String(r.perfil || "").toLowerCase());
}
const isDev = (roles = []) => roles.includes("desenvolvedor");

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

/** Escopo pelo vínculo da FOLHA (não pelo ff.empresa_id) */
async function ensureFolhaFuncionarioScopeByFF(userId, ffId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Acesso negado: usuário sem empresa vinculada.");

  const [[row]] = await pool.query(
    `SELECT f.empresa_id
       FROM folhas_funcionarios ff
       JOIN folhas f ON f.id = ff.folha_id
      WHERE ff.id = ? LIMIT 1`,
    [ffId]
  );
  if (!row) throw new Error("Registro não encontrado.");
  if (!empresas.includes(Number(row.empresa_id))) {
    throw new Error("Recurso fora do escopo do usuário.");
  }
  return true;
}

/** Adapter: garante req.userId mesmo que o requireAuth só preencha req.user */
router.use(requireAuth, (req, _res, next) => {
  if (!req.userId && req.user?.id) req.userId = req.user.id;
  next();
});

/* ======================= ROTAS ======================= */

/**
 * GET /api/folhas-funcionarios
 * Query:
 *  - folha_id?    -> quando vier, a empresa é derivada da própria folha
 *  - from?, to?   -> YYYY-MM (usados quando NÃO vier folha_id)
 *  - funcionario_id?, q?, scope? (scope=all só para dev)
 */
router.get("/folhas-funcionarios", async (req, res) => {
  try {
    const userId = req.userId;
    const roles = await getUserRoles(userId);
    const dev = isDev(roles);
    const scope = String(req.query.scope || "mine").toLowerCase();

    const folhaId = req.query.folha_id ? Number(req.query.folha_id) : null;
    const from = toYM(req.query.from);
    const to = toYM(req.query.to);
    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const q = normStr(req.query.q);

    // Empresas do usuário
    const empresasUser = await getUserEmpresaIds(userId);
    if (!empresasUser.length && !dev) {
      return res.json({ ok: true, items: [], scope: "mine" });
    }

    const where = [];
    const params = [];

    // LÓGICA CORRIGIDA: Se folha_id foi fornecido, usamos APENAS ele
    if (folhaId) {
      // Primeiro verifica se a folha existe e tem escopo válido
      const [[frow]] = await pool.query(
        `SELECT id, empresa_id, competencia FROM folhas WHERE id = ? LIMIT 1`,
        [folhaId]
      );
      
      if (!frow) {
        // Folha não existe - retorna vazio
        return res.json({ ok: true, items: [], scope: "mine" });
      }

      const empresaDaFolha = Number(frow.empresa_id);
      
      // Verifica escopo apenas se não for dev
      if (!dev && scope !== "all" && !empresasUser.includes(empresaDaFolha)) {
        // Folha de empresa fora do escopo - retorna vazio
        return res.json({ ok: true, items: [], scope: "mine" });
      }

      // Folha válida e com escopo - filtra APENAS por folha_id
      where.push(`ff.folha_id = ?`);
      params.push(folhaId);
      
    } else {
      // Sem folha_id: usa filtro por período e empresas do usuário
      if (!dev || scope !== "all") {
        where.push(`f.empresa_id IN (${empresasUser.map(() => "?").join(",")})`);
        params.push(...empresasUser);
      }

      if (from) { 
        where.push(`f.competencia >= ?`); 
        params.push(from); 
      }
      if (to) { 
        where.push(`f.competencia <= ?`); 
        params.push(to); 
      }
    }

    // Filtros adicionais (funcionário e busca)
    if (funcionarioId) { 
      where.push(`ff.funcionario_id = ?`); 
      params.push(funcionarioId); 
    }
    
    if (q) {
      where.push(`(
        CAST(ff.id AS CHAR) LIKE CONCAT('%',?,'%')
        OR UPPER(COALESCE(p.nome, CONCAT('#', fu.id))) LIKE UPPER(CONCAT('%',?,'%'))
        OR f.competencia LIKE CONCAT('%',?,'%')
      )`);
      params.push(q, q, q);
    }

    console.log('FF_QUERY_DEBUG:', {
      userId,
      folhaId,
      empresasUser,
      where: where.join(' AND '),
      params
    });

    const [rows] = await pool.query(
      `SELECT
         ff.id, ff.folha_id, ff.funcionario_id,
         f.competencia, f.empresa_id,
         COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
         ff.horas_normais, ff.he50_horas, ff.he100_horas,
         ff.valor_base, ff.valor_he50, ff.valor_he100,
         ff.descontos, ff.proventos, ff.total_liquido,
         ff.inconsistencias
       FROM folhas_funcionarios ff
       JOIN folhas f        ON f.id = ff.folha_id
       JOIN funcionarios fu ON fu.id = ff.funcionario_id
       LEFT JOIN pessoas p  ON p.id = fu.pessoa_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY f.competencia DESC, ff.id DESC`,
      params
    );

    console.log('FF_RESULTS:', rows.length, 'registros encontrados');

    return res.json({ 
      ok: true, 
      items: rows, 
      scope: dev && scope === "all" ? "all" : "mine"
    });
    
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({ 
      ok: false, 
      error: e.message || "Falha ao listar lançamentos." 
    });
  }
});

/** GET /api/folhas-funcionarios/:id */
router.get("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const userId = req.userId;
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScopeByFF(userId, id);

    const [[row]] = await pool.query(
      `SELECT
          ff.id, ff.folha_id, ff.funcionario_id,
          f.competencia, f.empresa_id,
          COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
          ff.horas_normais, ff.he50_horas, ff.he100_horas,
          ff.valor_base, ff.valor_he50, ff.valor_he100,
          ff.descontos, ff.proventos, ff.total_liquido,
          ff.inconsistencias
        FROM folhas_funcionarios ff
        JOIN folhas f        ON f.id = ff.folha_id
        JOIN funcionarios fu ON fu.id = ff.funcionario_id
        LEFT JOIN pessoas p  ON p.id = fu.pessoa_id
       WHERE ff.id = ? LIMIT 1`,
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
 * - Se vier folha_id: valida escopo pela empresa da folha (e usa a empresa da própria folha)
 * - Se NÃO vier folha_id: resolve por competencia + empresa do usuário (ou cria folha ABERTA se não existir)
 */
router.post("/folhas-funcionarios", async (req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const userId = req.userId;
    const roles = await getUserRoles(userId);
    const dev = isDev(roles);

    let { folha_id, competencia, funcionario_id } = req.body || {};
    folha_id = folha_id ? Number(folha_id) : null;
    competencia = toYM(competencia);
    funcionario_id = Number(funcionario_id);

    if (!funcionario_id) throw new Error("Informe funcionario_id.");
    if (!competencia && !folha_id) throw new Error("Informe competencia (YYYY-MM) ou folha_id.");

    let empresa_id;

    if (folha_id) {
      // Usa a empresa da própria folha (e valida escopo)
      const [[chk]] = await conn.query(
        `SELECT empresa_id, competencia FROM folhas WHERE id = ? LIMIT 1`,
        [folha_id]
      );
      if (!chk) throw new Error("Folha inexistente.");

      if (!dev) {
        const empresasUser = await getUserEmpresaIds(userId);
        if (!empresasUser.includes(Number(chk.empresa_id))) {
          throw new Error("Folha fora do escopo do usuário.");
        }
      }

      empresa_id = Number(chk.empresa_id);
      // mantém competencia coerente com a folha
      competencia = chk.competencia;
    } else {
      // Determina empresa fallback (usuário comum -> primeira empresa; dev pode forçar empresa_id no body)
      const empresasUser = await getUserEmpresaIds(userId);
      if (!dev && !empresasUser.length) throw new Error("Usuário sem empresa vinculada.");

      const alvo = dev && req.body.empresa_id ? Number(req.body.empresa_id) : empresasUser[0];
      if (!alvo) throw new Error("Não foi possível determinar a empresa.");

      const [[frow]] = await conn.query(
        `SELECT id, empresa_id FROM folhas WHERE competencia = ? AND empresa_id = ? LIMIT 1`,
        [competencia, alvo]
      );

      if (frow) {
        folha_id = Number(frow.id);
        empresa_id = Number(frow.empresa_id);
      } else {
        // comportamento legado: cria folha ABERTA automaticamente
        const [insF] = await conn.query(
          `INSERT INTO folhas (empresa_id, competencia, status, criado_em)
           VALUES (?, ?, 'ABERTA', NOW())`,
          [alvo, competencia]
        );
        folha_id = insF.insertId;
        empresa_id = alvo;
      }
    }

    // Evita duplicidade do mesmo funcionário na mesma folha
    const [[dup]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND funcionario_id = ? LIMIT 1`,
      [folha_id, funcionario_id]
    );
    if (dup) throw new Error("Já existe um lançamento para este funcionário nesta folha.");

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
        (empresa_id, folha_id, funcionario_id, horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100, descontos, proventos, total_liquido, inconsistencias)
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
    
    console.log('FF_CREATE_SUCCESS:', {
      id: ins.insertId,
      folha_id,
      competencia,
      funcionario_id,
      empresa_id
    });
    
    return res.json({ ok: true, id: ins.insertId, folha_id, competencia });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao criar lançamento." });
  } finally {
    if (conn) conn?.release();
  }
});

/** PUT /api/folhas-funcionarios/:id */
router.put("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const userId = req.userId;
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScopeByFF(userId, id);

    const sets = [];
    const params = [];
    const map = (k, v) => { sets.push(`${k} = ?`); params.push(v); };

    const changed = new Set(Object.keys(req.body || {}));

    if (req.body?.funcionario_id !== undefined) map("funcionario_id", Number(req.body.funcionario_id));
    if (req.body?.horas_normais !== undefined)  map("horas_normais",  numOrNull(req.body.horas_normais));
    if (req.body?.he50_horas !== undefined)     map("he50_horas",     numOrNull(req.body.he50_horas));
    if (req.body?.he100_horas !== undefined)    map("he100_horas",    numOrNull(req.body.he100_horas));
    if (req.body?.valor_base !== undefined)     map("valor_base",     numOrNull(req.body.valor_base));
    if (req.body?.valor_he50 !== undefined)     map("valor_he50",     numOrNull(req.body.valor_he50));
    if (req.body?.valor_he100 !== undefined)    map("valor_he100",    numOrNull(req.body.valor_he100));
    if (req.body?.descontos !== undefined)      map("descontos",      numOrNull(req.body.descontos));
    if (req.body?.proventos !== undefined)      map("proventos",      numOrNull(req.body.proventos));
    if (req.body?.total_liquido !== undefined)  map("total_liquido",  numOrNull(req.body.total_liquido));
    if (req.body?.inconsistencias !== undefined)map("inconsistencias",Number(req.body.inconsistencias || 0));

    // Se mudou algum valor monetário e total_liquido não foi enviado, recalcula
    const monetarios = ["valor_base","valor_he50","valor_he100","descontos","proventos"];
    const tocouMonetario = monetarios.some((k) => changed.has(k));
    const mandouTotal = changed.has("total_liquido");

    if (tocouMonetario && !mandouTotal) {
      const [[cur]] = await pool.query(
        `SELECT valor_base, valor_he50, valor_he100, descontos, proventos
           FROM folhas_funcionarios WHERE id = ?`,
        [id]
      );
      const patch = {
        valor_base:  numOrNull(changed.has("valor_base")  ? req.body.valor_base  : cur?.valor_base),
        valor_he50:  numOrNull(changed.has("valor_he50")  ? req.body.valor_he50  : cur?.valor_he50),
        valor_he100: numOrNull(changed.has("valor_he100") ? req.body.valor_he100 : cur?.valor_he100),
        descontos:   numOrNull(changed.has("descontos")   ? req.body.descontos   : cur?.descontos),
        proventos:   numOrNull(changed.has("proventos")   ? req.body.proventos   : cur?.proventos),
      };
      const novoTotal =
        (patch.valor_base  || 0) +
        (patch.valor_he50  || 0) +
        (patch.valor_he100 || 0) +
        (patch.proventos   || 0) -
        (patch.descontos   || 0);
      map("total_liquido", novoTotal);
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
router.delete("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const userId = req.userId;
    const id = Number(req.params.id);
    await ensureFolhaFuncionarioScopeByFF(userId, id);

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