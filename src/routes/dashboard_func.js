import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ========== helpers comuns ========== */

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

async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id
       FROM empresas_usuarios
      WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem empresa vinculada.");
  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
}

const pad2 = (n) => String(n).padStart(2, "0");
function nowBR() {
  // usa horário do servidor; se precisar, troque para fuso específico
  const d = new Date();
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { iso, hhmm, date: d };
}

/* ========== resolve funcionário vinculado ao usuário para a empresa ========== */
/** retorna: { id, pessoa_nome, cargo_nome } */
async function getFuncionarioDoUsuario(empresaId, userId) {
  // vinculo 1:1 via usuarios_pessoas
  const [rows] = await pool.query(
    `
    SELECT f.id,
           p.nome  AS pessoa_nome,
           c.nome  AS cargo_nome
      FROM usuarios_pessoas up
      JOIN pessoas p       ON p.id = up.pessoa_id
      JOIN funcionarios f  ON f.pessoa_id = p.id AND f.empresa_id = up.empresa_id
      LEFT JOIN cargos c   ON c.id = f.cargo_id
     WHERE up.empresa_id = ? AND up.usuario_id = ?
     LIMIT 1
    `,
    [empresaId, userId]
  );
  return rows[0] || null;
}

/* ========== GET /api/dashboard_func/hoje ========== */
/**
 * Retorna dados agregados para a tela do colaborador.
 * Query opcional: ?empresa_id=...
 * Resposta:
 * {
 *   ok, empresa_id,
 *   funcionario: { id, pessoa_nome, cargo_nome },
 *   data: "YYYY-MM-DD",
 *   escala: [{id, entrada, saida, turno_ordem}],
 *   apontamentos: [{id, turno_ordem, entrada, saida, origem}],
 *   estado: "TRABALHANDO" | "FORA"
 * }
 */
router.get("/hoje", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário." });

    const { iso } = nowBR();

    const [esc] = await pool.query(
      `
        SELECT id, entrada, saida, turno_ordem
          FROM escalas
         WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
         ORDER BY turno_ordem ASC
      `,
      [empresaId, func.id, iso]
    );

    const [ap] = await pool.query(
      `
        SELECT id, turno_ordem, entrada, saida, origem
          FROM apontamentos
         WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
         ORDER BY turno_ordem ASC, id ASC
      `,
      [empresaId, func.id, iso]
    );

    const aberto = ap.find((a) => a.entrada && !a.saida);
    const estado = aberto ? "TRABALHANDO" : "FORA";

    return res.json({
      ok: true,
      empresa_id: empresaId,
      funcionario: func,
      data: iso,
      escala: esc,
      apontamentos: ap,
      estado,
    });
  } catch (e) {
    console.error("DASH_FUNC_HOJE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao carregar painel." });
  }
});

/* ========== POST /api/dashboard_func/clock ========== */
/**
 * Bater ponto (toggle).
 * Body opcional: { empresa_id } (se tiver múltiplas empresas).
 * Lógica:
 *  - se houver apontamento aberto hoje → fecha com saída agora
 *  - senão → cria apontamento com entrada agora (turno_ordem = máx + 1)
 */
router.post("/clock", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.body?.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário." });

    const { iso, hhmm } = nowBR();

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // pega apontamentos de hoje
    const [aps] = await conn.query(
      `SELECT id, turno_ordem, entrada, saida, origem
         FROM apontamentos
        WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
        ORDER BY turno_ordem ASC, id ASC`,
      [empresaId, func.id, iso]
    );

    const aberto = aps.find((a) => a.entrada && !a.saida);

    if (aberto) {
      // fechar
      await conn.query(
        `UPDATE apontamentos
            SET saida = ?
          WHERE id = ?`,
        [hhmm, aberto.id]
      );
      await conn.commit();
      return res.json({ ok: true, action: "saida", id: aberto.id, saida: hhmm });
    } else {
      // novo
      const maxTurno = aps.reduce((m, a) => Math.max(m, Number(a.turno_ordem || 1)), 0) || 0;

      // regra de unicidade (empresa_id, funcionario_id, data, turno_ordem, origem)
      // aqui usamos origem = APONTADO
      const [ins] = await conn.query(
        `INSERT INTO apontamentos
           (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
         VALUES (?,?,?,?,?,?,?,NULL)`,
        [empresaId, func.id, iso, maxTurno + 1, hhmm, null, "APONTADO"]
      );

      await conn.commit();
      return res.json({ ok: true, action: "entrada", id: ins.insertId, entrada: hhmm, turno_ordem: maxTurno + 1 });
    }
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("DASH_FUNC_CLOCK_ERR", e);
    const msg = String(e?.message || "");
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade: já existe um registro igual." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao registrar ponto." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
