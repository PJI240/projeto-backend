import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

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

/* ======================= ROTAS PARA O FRONT ======================= */

router.use(requireAuth);

/** GET /api/folhas -> lista folhas visíveis ao usuário */
router.get("/folhas", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    let rows;
    if (dev) {
      [rows] = await pool.query(
        `SELECT id, empresa_id, competencia, status
           FROM folhas
         ORDER BY competencia DESC, id DESC`
      );
    } else {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length) return res.json({ folhas: [] });
      [rows] = await pool.query(
        `SELECT id, empresa_id, competencia, status
           FROM folhas
          WHERE empresa_id IN (?)
          ORDER BY competencia DESC, id DESC`,
        [empresas]
      );
    }
    res.json({ folhas: rows });
  } catch (e) {
    console.error("GET /folhas error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar folhas." });
  }
});

/** GET /api/folhas/:folhaId -> detalhe da folha (id, empresa_id, competencia, status) */
router.get("/folhas/:folhaId", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);
    res.json(folha);
  } catch (e) {
    res.status(404).json({ ok: false, error: e.message || "Folha não encontrada." });
  }
});

/** GET /api/folhas/:folhaId/funcionarios -> lançamentos da folha (enriquecidos com nome/cpf) */
router.get("/folhas/:folhaId/funcionarios", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);
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
    res.json(rows);
  } catch (e) {
    console.error("GET /folhas/:id/funcionarios error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao listar funcionários da folha." });
  }
});

/** GET /api/folhas/:folhaId/candidatos?search=... -> funcionários ativos da mesma empresa e NÃO incluídos */
router.get("/folhas/:folhaId/candidatos", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);
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
       LIMIT 100
      `,
      q
        ? [folha.empresa_id, folha.id, folha.empresa_id, like, q]
        : [folha.empresa_id, folha.id, folha.empresa_id]
    );

    res.json(rows);
  } catch (e) {
    console.error("GET /folhas/:id/candidatos error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao buscar candidatos." });
  }
});

/** POST /api/folhas/:folhaId/funcionarios { funcionario_id } -> inclui (bloqueia se folha fechada) */
router.post("/folhas/:folhaId/funcionarios", async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);
    const funcionarioId = Number(req.body?.funcionario_id);
    if (!funcionarioId) return res.status(400).json({ ok: false, error: "Informe funcionario_id." });

    const status = String(folha.status || "").toLowerCase();
    if (!["rascunho", "aberta", "aberto"].includes(status)) {
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
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);
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

/** POST /api/folhas/:folhaId/funcionarios/recalcular { ids?: number[] }
 *  Stub seguro: confirma OK. Substitua pelo recálculo real quando quiser. */
router.post("/folhas/:folhaId/funcionarios/recalcular", async (req, res) => {
  try {
    const folha = await getFolhaIfAllowed(req.userId, req.params.folhaId);

    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length === 0) {
      const [all] = await pool.query(
        `SELECT id FROM folhas_funcionarios WHERE folha_id = ? AND empresa_id = ?`,
        [folha.id, folha.empresa_id]
      );
      ids = all.map((r) => r.id);
    }

    // TODO: aqui entra sua lógica real de recálculo
    res.json({ ok: true, count: ids.length, results: ids.map((id) => ({ id, ok: true })) });
  } catch (e) {
    console.error("POST /folhas/:id/funcionarios/recalcular error:", e);
    res.status(400).json({ ok: false, error: e.message || "Falha ao recalcular." });
  }
});

export default router;