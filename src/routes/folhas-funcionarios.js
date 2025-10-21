// src/routes/folhas-funcionarios.js
import { pool } from "../db.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { pool } from "../db.js";

const router = Router();

/* ===================== helpers ===================== */

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

/** Empresas acessíveis ao usuário (mesmo padrão do arquivo apontamentos.js) */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `
    SELECT DISTINCT COALESCE(f.empresa_id, up.empresa_id) AS empresa_id
      FROM usuarios_pessoas up
 LEFT JOIN funcionarios f
        ON f.pessoa_id = up.pessoa_id
       AND (f.ativo = 1 OR f.ativo IS NULL)
     WHERE up.usuario_id = ?
    `,
    [userId]
  );
  return rows.map((r) => r.empresa_id).filter((v) => v != null);
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem vínculo a nenhuma empresa.");

  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
}

/** Normaliza decimal vindo do body (aceita "1.234,56" e "1234.56"). */
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

function toNullOrString(s) {
  if (s == null) return null;
  const t = String(s).trim();
  return t ? t : null;
}

/** Confere se a FOLHA pertence à empresa */
async function assertFolhaEmpresa(conn, folhaId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM folhas WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [Number(folhaId), Number(empresaId)]
  );
  if (!row) throw new Error("Folha não pertence à empresa selecionada.");
}

/** Confere se o FUNCIONÁRIO pertence à empresa */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [Number(funcionarioId), Number(empresaId)]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}

/** Calcula total líquido se não informado explicitamente */
function computeTotalLiquido(payload) {
  const vb = normDec(payload.valor_base);
  const v50 = normDec(payload.valor_he50);
  const v100 = normDec(payload.valor_he100);
  const prov = normDec(payload.proventos);
  const desc = normDec(payload.descontos);
  return vb + v50 + v100 + prov - desc;
}

/* ===================== GET /api/folhas-funcionarios ===================== */
/**
 * Parâmetros:
 *  - empresa_id? (opcional: resolvido por contexto se ausente)
 *  - folha_id   (obrigatório)
 *  - funcionario_id? (opcional)
 *  - q? (opcional, busca por inconsistencias; se quiser nome, ver LEFT JOIN funcionários)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const folhaId = Number(req.query.folha_id);
    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const q = String(req.query.q || "").trim();

    if (!folhaId) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'folha_id' é obrigatório." });
    }

    const params = [empresaId, folhaId];
    let extra = "";

    if (funcionarioId) {
      extra += " AND ff.funcionario_id = ? ";
      params.push(funcionarioId);
    }
    if (q) {
      extra += " AND (ff.inconsistencias LIKE ?) ";
      params.push(`%${q}%`);
    }

    // Garantir que a folha consultada é da empresa
    const [[chk]] = await pool.query(
      `SELECT id FROM folhas WHERE id = ? AND empresa_id = ? LIMIT 1`,
      [folhaId, empresaId]
    );
    if (!chk) {
      return res.status(403).json({ ok: false, error: "Folha não pertence à empresa." });
    }

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
        ff.inconsistencias
      FROM folhas_funcionarios ff
      WHERE ff.empresa_id = ?
        AND ff.folha_id = ?
        ${extra}
      ORDER BY ff.funcionario_id ASC, ff.id ASC
      `,
      params
    );

    return res.json({ ok: true, empresa_id: empresaId, folha_id: folhaId, folhas_funcionarios: rows });
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao listar folhas_funcionarios." });
  }
});

/* ===================== POST /api/folhas-funcionarios ===================== */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const {
      folha_id,
      funcionario_id,
      horas_normais = 0,
      he50_horas = 0,
      he100_horas = 0,
      valor_base = 0,
      valor_he50 = 0,
      valor_he100 = 0,
      descontos = 0,
      proventos = 0,
      total_liquido = null,
      inconsistencias = null,
    } = req.body || {};

    if (!Number(folha_id) || !Number(funcionario_id)) {
      return res.status(400).json({ ok: false, error: "Folha e Funcionário são obrigatórios." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFolhaEmpresa(conn, Number(folha_id), empresaId);
    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    const payload = {
      empresa_id: empresaId,
      folha_id: Number(folha_id),
      funcionario_id: Number(funcionario_id),
      horas_normais: normDec(horas_normais),
      he50_horas: normDec(he50_horas),
      he100_horas: normDec(he100_horas),
      valor_base: normDec(valor_base),
      valor_he50: normDec(valor_he50),
      valor_he100: normDec(valor_he100),
      descontos: normDec(descontos),
      proventos: normDec(proventos),
      total_liquido:
        total_liquido === null || total_liquido === "" ? null : normDec(total_liquido),
      inconsistencias: toNullOrString(inconsistencias),
    };
    if (payload.total_liquido == null) {
      payload.total_liquido = computeTotalLiquido(payload);
    }

    const [ins] = await conn.query(
      `
      INSERT INTO folhas_funcionarios
        (empresa_id, folha_id, funcionario_id,
         horas_normais, he50_horas, he100_horas,
         valor_base, valor_he50, valor_he100,
         descontos, proventos, total_liquido, inconsistencias)
      VALUES (?,?,?,?, ?,?,?, ?,?,?, ?,?,?)
      `,
      [
        payload.empresa_id, payload.folha_id, payload.funcionario_id,
        payload.horas_normais, payload.he50_horas, payload.he100_horas,
        payload.valor_base, payload.valor_he50, payload.valor_he100,
        payload.descontos, payload.proventos, payload.total_liquido, payload.inconsistencias
      ]
    );

    await conn.commit();
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    const msg = String(e?.message || "");
    if (/duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar registro." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/folhas-funcionarios/:id ===================== */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    const {
      folha_id,
      funcionario_id,
      horas_normais = 0,
      he50_horas = 0,
      he100_horas = 0,
      valor_base = 0,
      valor_he50 = 0,
      valor_he100 = 0,
      descontos = 0,
      proventos = 0,
      total_liquido = null,
      inconsistencias = null,
    } = req.body || {};

    if (!Number(folha_id) || !Number(funcionario_id)) {
      return res.status(400).json({ ok: false, error: "Folha e Funcionário são obrigatórios." });
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Confere empresa do registro
    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM folhas_funcionarios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Registro não encontrado para a empresa selecionada.");
    }

    await assertFolhaEmpresa(conn, Number(folha_id), empresaId);
    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    const payload = {
      horas_normais: normDec(horas_normais),
      he50_horas: normDec(he50_horas),
      he100_horas: normDec(he100_horas),
      valor_base: normDec(valor_base),
      valor_he50: normDec(valor_he50),
      valor_he100: normDec(valor_he100),
      descontos: normDec(descontos),
      proventos: normDec(proventos),
      total_liquido:
        total_liquido === null || total_liquido === "" ? null : normDec(total_liquido),
      inconsistencias: toNullOrString(inconsistencias),
    };
    if (payload.total_liquido == null) {
      payload.total_liquido = computeTotalLiquido(payload);
    }

    await conn.query(
      `
      UPDATE folhas_funcionarios
         SET folha_id = ?,
             funcionario_id = ?,
             horas_normais = ?,
             he50_horas = ?,
             he100_horas = ?,
             valor_base = ?,
             valor_he50 = ?,
             valor_he100 = ?,
             descontos = ?,
             proventos = ?,
             total_liquido = ?,
             inconsistencias = ?
       WHERE id = ? AND empresa_id = ?
      `,
      [
        Number(folha_id), Number(funcionario_id),
        payload.horas_normais, payload.he50_horas, payload.he100_horas,
        payload.valor_base, payload.valor_he50, payload.valor_he100,
        payload.descontos, payload.proventos, payload.total_liquido, payload.inconsistencias,
        id, empresaId
      ]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_UPDATE_ERR", e);
    const msg = String(e?.message || "");
    if (/duplicad|duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao atualizar registro." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/folhas-funcionarios/:id ===================== */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM folhas_funcionarios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Registro não encontrado para a empresa selecionada.");
    }

    await conn.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir registro." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
