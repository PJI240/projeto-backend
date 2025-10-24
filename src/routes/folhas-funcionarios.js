import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===================== Auth compatível com perfis_permissoes ===================== */
function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "Não autenticado." });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;            // <- padrão usado no projeto
    // compat: se alguém usar req.user?.id em outro lugar
    req.user = req.user || {};
    if (req.userId && !req.user.id) req.user.id = req.userId;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

/* ===================== helpers enxutos ===================== */

/** Empresas acessíveis ao usuário (fonte única: empresas_usuarios) */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `
    SELECT empresa_id
      FROM empresas_usuarios
     WHERE usuario_id = ?
       AND ativo = 1
    `,
    [userId]
  );
  return rows.map((r) => r.empresa_id).filter((v) => v != null);
}

/** Resolve a empresa pela própria folha e valida se o usuário tem acesso */
async function resolveEmpresaByFolha(userId, folhaId) {
  const [[folha]] = await pool.query(
    `SELECT empresa_id FROM folhas WHERE id = ? LIMIT 1`,
    [Number(folhaId)]
  );
  if (!folha) throw Object.assign(new Error("Folha inexistente."), { status: 404 });

  const empresasUser = await getUserEmpresaIds(userId);
  if (!empresasUser.includes(folha.empresa_id)) {
    const err = new Error("Usuário não tem acesso à empresa da folha.");
    err.status = 403;
    throw err;
  }
  return folha.empresa_id;
}

/** Normaliza decimal (aceita "1.234,56" e "1234.56"). */
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
 * Query params:
 *  - folha_id   (obrigatório)
 *  - funcionario_id? (opcional)
 *  - q? (opcional; pesquisa em 'inconsistencias' - texto)
 */
router.get("/", requireAuth, async (req, res) => {
  try {
    const folhaId = Number(req.query.folha_id);
    if (!folhaId) {
      return res
        .status(400)
        .json({ ok: false, error: "Parâmetro 'folha_id' é obrigatório." });
    }

    // empresa é definida pela folha (simples e correto)
    const userId = req.userId || req.user?.id;
    const empresaId = await resolveEmpresaByFolha(userId, folhaId);

    const funcionarioId = req.query.funcionario_id
      ? Number(req.query.funcionario_id)
      : null;
    const q = String(req.query.q || "").trim();

    const params = [empresaId, folhaId];
    let extra = "";

    if (funcionarioId) {
      extra += " AND ff.funcionario_id = ? ";
      params.push(funcionarioId);
    }
    if (q) {
      extra += " AND ff.inconsistencias LIKE ? ";
      params.push(`%${q}%`);
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
        AND ff.folha_id   = ?
        ${extra}
      ORDER BY ff.funcionario_id ASC, ff.id ASC
      `,
      params
    );

    return res.json({
      ok: true,
      empresa_id: empresaId,
      folha_id: folhaId,
      folhas_funcionarios: rows,
    });
  } catch (e) {
    console.error("FF_LIST_ERR", e);
    const status = e?.status || 400;
    return res
      .status(status)
      .json({ ok: false, error: e.message || "Falha ao listar folhas_funcionarios." });
  }
});

/* ===================== POST /api/folhas-funcionarios ===================== */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
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
      inconsistencias = null, // TEXTO
    } = req.body || {};

    if (!Number(folha_id) || !Number(funcionario_id)) {
      return res
        .status(400)
        .json({ ok: false, error: "Folha e Funcionário são obrigatórios." });
    }

    // empresa vem da própria folha
    const userId = req.userId || req.user?.id;
    const empresaId = await resolveEmpresaByFolha(userId, Number(folha_id));

    conn = await pool.getConnection();
    await conn.beginTransaction();

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
        total_liquido === null || total_liquido === ""
          ? null
          : normDec(total_liquido),
      inconsistencias: toNullOrString(inconsistencias), // **TEXTO**
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
        payload.empresa_id,
        payload.folha_id,
        payload.funcionario_id,
        payload.horas_normais,
        payload.he50_horas,
        payload.he100_horas,
        payload.valor_base,
        payload.valor_he50,
        payload.valor_he100,
        payload.descontos,
        payload.proventos,
        payload.total_liquido,
        payload.inconsistencias,
      ]
    );

    await conn.commit();
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_CREATE_ERR", e);
    const msg = String(e?.message || "");
    if (/duplicate entry/i.test(msg)) {
      return res
        .status(409)
        .json({ ok: false, error: "Conflito de duplicidade." });
    }
    const status = e?.status || 400;
    return res
      .status(status)
      .json({ ok: false, error: msg || "Falha ao criar registro." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/folhas-funcionarios/:id ===================== */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
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
      inconsistencias = null, // TEXTO
    } = req.body || {};

    if (!Number(folha_id) || !Number(funcionario_id)) {
      return res
        .status(400)
        .json({ ok: false, error: "Folha e Funcionário são obrigatórios." });
    }

    // empresa coerente com a (nova) folha
    const userId = req.userId || req.user?.id;
    const empresaId = await resolveEmpresaByFolha(userId, Number(folha_id));

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Garante que o registro existe
    const [[ex]] = await conn.query(
      `SELECT id FROM folhas_funcionarios WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!ex) throw Object.assign(new Error("Registro não encontrado."), { status: 404 });

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
        total_liquido === null || total_liquido === ""
          ? null
          : normDec(total_liquido),
      inconsistencias: toNullOrString(inconsistencias), // **TEXTO**
    };
    if (payload.total_liquido == null) {
      payload.total_liquido = computeTotalLiquido(payload);
    }

    await conn.query(
      `
      UPDATE folhas_funcionarios
         SET empresa_id     = ?,   -- mantém coerência com a nova folha
             folha_id       = ?,
             funcionario_id = ?,
             horas_normais  = ?,
             he50_horas     = ?,
             he100_horas    = ?,
             valor_base     = ?,
             valor_he50     = ?,
             valor_he100    = ?,
             descontos      = ?,
             proventos      = ?,
             total_liquido  = ?,
             inconsistencias= ?
       WHERE id = ?
      `,
      [
        empresaId,
        Number(folha_id),
        Number(funcionario_id),
        payload.horas_normais,
        payload.he50_horas,
        payload.he100_horas,
        payload.valor_base,
        payload.valor_he50,
        payload.valor_he100,
        payload.descontos,
        payload.proventos,
        payload.total_liquido,
        payload.inconsistencias,
        id,
      ]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_UPDATE_ERR", e);
    const msg = String(e?.message || "");
    if (/duplicad|duplicate entry/i.test(msg)) {
      return res
        .status(409)
        .json({ ok: false, error: "Conflito de duplicidade." });
    }
    const status = e?.status || 400;
    return res
      .status(status)
      .json({ ok: false, error: msg || "Falha ao atualizar registro." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/folhas-funcionarios/:id ===================== */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Recupera a folha do registro, valida acesso do usuário via empresa
    const [[reg]] = await conn.query(
      `
      SELECT ff.id, ff.folha_id
        FROM folhas_funcionarios ff
       WHERE ff.id = ?
       LIMIT 1
      `,
      [id]
    );
    if (!reg) throw Object.assign(new Error("Registro não encontrado."), { status: 404 });

    const userId = req.userId || req.user?.id;
    await resolveEmpresaByFolha(userId, Number(reg.folha_id));

    await conn.query(`DELETE FROM folhas_funcionarios WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("FF_DELETE_ERR", e);
    const status = e?.status || 400;
    return res
      .status(status)
      .json({ ok: false, error: e.message || "Falha ao excluir registro." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;