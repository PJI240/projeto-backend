// src/routes/folhas-funcionarios.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ======================= HELPERS ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => { const s = norm(v); return s.length ? s : null; };

// "outubro de 2025", "2025-10" ou "2025-10-01" -> "2025-10"
function toYM(input) {
  const s = norm(input).toLowerCase();
  if (!s) return null;
  const mIso = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (mIso) return `${mIso[1]}-${mIso[2]}`;
  const meses = {
    janeiro:"01", fevereiro:"02", março:"03", marco:"03", abril:"04", maio:"05",
    junho:"06", julho:"07", agosto:"08", setembro:"09", outubro:"10", novembro:"11", dezembro:"12",
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

/* ===== helpers compatíveis com cargos.js ===== */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT eu.empresa_id
       FROM empresas_usuarios eu
      WHERE eu.usuario_id = ? AND eu.ativo = 1`,
    [userId]
  );
  return rows.map((r) => Number(r.empresa_id));
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");
  if (empresaIdQuery != null) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
}

function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok:false, error:"Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ ok:false, error:"Sessão inválida." });
  }
}

/* ======================= ROTAS ======================= */

/**
 * GET /api/folhas-funcionarios
 * Query:
 *  - empresa_id?      (opcional, valida escopo)
 *  - folha_id?        (se vier, domina o período)
 *  - from?, to?       (YYYY-MM, usados quando NÃO vier folha_id)
 *  - funcionario_id?, q?
 */
router.get("/folhas-funcionarios", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    const folhaId = req.query.folha_id ? Number(req.query.folha_id) : null;
    const from = toYM(req.query.from);
    const to   = toYM(req.query.to);
    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const q = normStr(req.query.q);

    const where = ["f.empresa_id = ?"];
    const params = [empresaId];

    if (folhaId) {
      // garante que a folha pertence à empresa
      const [[okFolha]] = await pool.query(
        `SELECT 1 FROM folhas WHERE id = ? AND empresa_id = ? LIMIT 1`,
        [folhaId, empresaId]
      );
      if (!okFolha) return res.json({ ok:true, items: [] }); // fora do escopo
      where.push(`ff.folha_id = ?`);
      params.push(folhaId);
    } else {
      if (from) { where.push(`f.competencia >= ?`); params.push(from); }
      if (to)   { where.push(`f.competencia <= ?`); params.push(to);   }
    }

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
         ff.id, ff.folha_id, ff.funcionario_id,
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
       WHERE ${where.join(" AND ")}
       ORDER BY f.competencia DESC, ff.id DESC`,
      params
    );

    return res.json({ ok: true, items: rows, empresa_id: empresaId });
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({ ok:false, error: e.message || "Falha ao listar lançamentos." });
  }
});

/** GET /api/folhas-funcionarios/:id */
router.get("/folhas-funcionarios/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    const [[row]] = await pool.query(
      `SELECT
          ff.id, ff.folha_id, ff.funcionario_id,
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
       WHERE ff.id = ? AND f.empresa_id = ?
       LIMIT 1`,
      [id, empresaId]
    );

    if (!row) return res.status(404).json({ ok:false, error:"Registro não encontrado." });
    return res.json({ ok:true, item: row, empresa_id: empresaId });
  } catch (e) {
    console.error("FF_GET_ERR", e);
    return res.status(400).json({ ok:false, error: e.message || "Falha ao obter registro." });
  }
});

/**
 * POST /api/folhas-funcionarios
 * body: { folha_id? , competencia? (YYYY-MM), funcionario_id, ...valores }
 * - Usa a empresa do contexto (resolveEmpresaContext)
 * - Se não vier folha_id, acha/cria folha (ABERTA) da mesma empresa e competência
 */
router.post("/folhas-funcionarios", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let { folha_id, competencia, funcionario_id } = req.body || {};
    folha_id = folha_id ? Number(folha_id) : null;
    competencia = toYM(competencia);
    funcionario_id = Number(funcionario_id);

    if (!funcionario_id) throw new Error("Informe funcionario_id.");
    if (!competencia && !folha_id) throw new Error("Informe competencia (YYYY-MM) ou folha_id.");

    if (folha_id) {
      // valida que a folha pertence à empresa do contexto
      const [[okFolha]] = await conn.query(
        `SELECT competencia FROM folhas WHERE id = ? AND empresa_id = ? LIMIT 1`,
        [folha_id, empresaId]
      );
      if (!okFolha) throw new Error("Folha fora do escopo da empresa.");
      competencia = okFolha.competencia; // mantém consistente
    } else {
      // acha/cria folha da empresaId para a competência
      const [[frow]] = await conn.query(
        `SELECT id FROM folhas WHERE empresa_id = ? AND competencia = ? LIMIT 1`,
        [empresaId, competencia]
      );
      if (frow) {
        folha_id = Number(frow.id);
      } else {
        const [insFolha] = await conn.query(
          `INSERT INTO folhas (empresa_id, competencia, status, criado_em)
           VALUES (?,?, 'ABERTA', NOW())`,
          [empresaId, competencia]
        );
        folha_id = insFolha.insertId;
      }
    }

    // unicidade
    const [[dup]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND funcionario_id = ? LIMIT 1`,
      [folha_id, funcionario_id]
    );
    if (dup) throw new Error("Já existe um lançamento para este funcionário nesta folha.");

    const payload = {
      empresa_id: empresaId,
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
    return res.json({ ok:true, id: ins.insertId, folha_id, competencia, empresa_id: empresaId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    return res.status(400).json({ ok:false, error: e.message || "Falha ao criar lançamento." });
  } finally {
    if (conn) conn.release();
  }
});

/** PUT /api/folhas-funcionarios/:id */
router.put("/folhas-funcionarios/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // garante pertencimento
    const [[okRow]] = await pool.query(
      `SELECT 1
         FROM folhas_funcionarios ff
         JOIN folhas f ON f.id = ff.folha_id
        WHERE ff.id = ? AND f.empresa_id = ?
        LIMIT 1`,
      [id, empresaId]
    );
    if (!okRow) return res.status(404).json({ ok:false, error:"Registro não encontrado na empresa." });

    const sets = [];
    const params = [];
    const map = (k, v) => { sets.push(`${k} = ?`); params.push(v); };

    const changed = new Set(Object.keys(req.body || {}));

    // (não permitimos trocar folha_id/empresa_id por aqui)
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

    // recalcula total se necessário
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

    if (!sets.length) return res.json({ ok:true, changed:0 });

    params.push(id);
    await pool.query(`UPDATE folhas_funcionarios SET ${sets.join(", ")} WHERE id = ?`, params);
    return res.json({ ok:true });
  } catch (e) {
    console.error("FF_UPDATE_ERR", e);
    return res.status(400).json({ ok:false, error: e.message || "Falha ao atualizar lançamento." });
  }
});

/** DELETE /api/folhas-funcionarios/:id */
router.delete("/folhas-funcionarios/:id", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);

    // valida pertencimento
    const [[okRow]] = await pool.query(
      `SELECT 1
         FROM folhas_funcionarios ff
         JOIN folhas f ON f.id = ff.folha_id
        WHERE ff.id = ? AND f.empresa_id = ?
        LIMIT 1`,
      [id, empresaId]
    );
    if (!okRow) return res.status(404).json({ ok:false, error:"Registro não encontrado na empresa." });

    await pool.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);
    return res.json({ ok:true });
  } catch (e) {
    if (e?.code === "ER_ROW_IS_REFERENCED_2" || e?.errno === 1451) {
      return res.status(409).json({ ok:false, error:"Não é possível excluir: registro referenciado." });
    }
    console.error("FF_DELETE_ERR", e);
    return res.status(400).json({ ok:false, error: e.message || "Falha ao excluir lançamento." });
  }
});

export default router;