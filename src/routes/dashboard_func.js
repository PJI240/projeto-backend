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
  const d = new Date();
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  // CORREÇÃO: Garantir formato HH:MM:SS para compatibilidade com TIME do MySQL
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return { iso, time, date: d };
}

/* ========== resolve funcionário vinculado ao usuário para a empresa ========== */
async function getFuncionarioDoUsuario(empresaId, userId) {
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
router.post("/clock", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.body?.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário." });

    const { iso, time } = nowBR(); // CORREÇÃO: usar 'time' ao invés de 'hhmm'

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
      // CORREÇÃO: Validar se a hora de saída é posterior à entrada
      if (aberto.entrada && time <= aberto.entrada) {
        await conn.rollback();
        return res.status(400).json({ 
          ok: false, 
          error: "Hora de saída deve ser posterior à hora de entrada." 
        });
      }

      // CORREÇÃO: Usar transação para garantir consistência
      await conn.query(
        `UPDATE apontamentos
            SET saida = ?, atualizado_em = NOW()
          WHERE id = ?`,
        [time, aberto.id]
      );
      
      await conn.commit();
      return res.json({ ok: true, action: "saida", id: aberto.id, saida: time });
    } else {
      // novo apontamento de entrada
      const maxTurno = aps.reduce((m, a) => Math.max(m, Number(a.turno_ordem || 1)), 0) || 0;

      const [ins] = await conn.query(
        `INSERT INTO apontamentos
           (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs, criado_em, atualizado_em)
         VALUES (?,?,?,?,?,?,?,NULL,NOW(),NOW())`,
        [empresaId, func.id, iso, maxTurno + 1, time, null, "APONTADO"]
      );

      await conn.commit();
      return res.json({ 
        ok: true, 
        action: "entrada", 
        id: ins.insertId, 
        entrada: time, 
        turno_ordem: maxTurno + 1 
      });
    }
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("DASH_FUNC_CLOCK_ERR", e);
    const msg = String(e?.message || "");
    
    // CORREÇÃO: Melhor tratamento de erros específicos
    if (/invalid time|hour|minute|second/i.test(msg)) {
      return res.status(400).json({ ok: false, error: "Formato de hora inválido." });
    }
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Já existe um registro com esses dados." });
    }
    if (/check constraint|constraint fails/i.test(msg)) {
      return res.status(400).json({ ok: false, error: "Regra de negócio violada: " + msg });
    }
    
    return res.status(400).json({ ok: false, error: msg || "Falha ao registrar ponto." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
