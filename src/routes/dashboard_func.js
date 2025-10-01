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
  // Ajusta para o fuso horário de Brasília (UTC-3)
  const offset = -3 * 60; // UTC-3 em minutos
  d.setMinutes(d.getMinutes() + d.getTimezoneOffset() + offset);
  
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return { iso, hhmm, date: d };
}

/* ========== resolve funcionário vinculado ao usuário para a empresa (robusta) ========== */
async function getFuncionarioDoUsuario(empresaId, userId) {
  const [rows] = await pool.query(
    `
    SELECT
      f.id,
      p.nome  AS pessoa_nome,
      c.nome  AS cargo_nome
    FROM empresas_usuarios eu
    /* mesmo usuário + MESMA empresa */
    JOIN usuarios_pessoas up
      ON up.usuario_id = eu.usuario_id
     AND up.empresa_id = eu.empresa_id
    /* funcionário da MESMA pessoa e MESMA empresa */
    JOIN funcionarios f
      ON f.pessoa_id  = up.pessoa_id
     AND f.empresa_id = eu.empresa_id
    LEFT JOIN pessoas p ON p.id = f.pessoa_id
    LEFT JOIN cargos  c ON c.id = f.cargo_id
    WHERE eu.usuario_id = ?
      AND eu.empresa_id = ?
      AND eu.ativo = 1
    /* se houver duplicidade, preferir ativo (se existir) e id menor */
    ORDER BY COALESCE(f.ativo, 1) DESC, f.id ASC
    LIMIT 1
    `,
    [userId, empresaId]
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

    const { iso, hhmm } = nowBR();

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // Validação do formato de hora
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(hhmm)) {
      throw new Error(`Formato de hora inválido: ${hhmm}`);
    }

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
      // CORREÇÃO PRINCIPAL: Validação mais flexível para horários
      const entradaTime = new Date(`${iso}T${aberto.entrada}`).getTime();
      const saidaTime = new Date(`${iso}T${hhmm}`).getTime();
      
      // Permite saída no dia seguinte (quando saidaTime < entradaTime)
      // Mas ainda valida casos absurdos (mais de 12 horas de diferença negativa)
      const diffHoras = (saidaTime - entradaTime) / (1000 * 60 * 60);
      
      if (diffHoras < -12) {
        throw new Error("Horário de saída inválido: diferença muito grande em relação à entrada");
      }

      // Se a saída for anterior à entrada, assume que é no dia seguinte
      const saidaFinal = saidaTime < entradaTime ? hhmm : hhmm;

      // fechar apontamento
      await conn.query(
        `UPDATE apontamentos
            SET saida = ?, updated_at = NOW()
          WHERE id = ?`,
        [saidaFinal, aberto.id]
      );
      
      await conn.commit();
      return res.json({ 
        ok: true, 
        action: "saida", 
        id: aberto.id, 
        saida: saidaFinal,
        message: "Saída registrada com sucesso!"
      });
    } else {
      // novo apontamento
      const maxTurno = aps.reduce((m, a) => Math.max(m, Number(a.turno_ordem || 1)), 0) || 0;

      // Verifica se já existe apontamento com mesma chave
      const [existing] = await conn.query(
        `SELECT id FROM apontamentos 
         WHERE empresa_id = ? AND funcionario_id = ? AND data = ? AND turno_ordem = ? AND origem = ?`,
        [empresaId, func.id, iso, maxTurno + 1, "APONTADO"]
      );

      if (existing.length > 0) {
        throw new Error("Já existe um apontamento para este turno");
      }

      const [ins] = await conn.query(
        `INSERT INTO apontamentos
           (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,NOW(),NOW())`,
        [empresaId, func.id, iso, maxTurno + 1, hhmm, null, "APONTADO"]
      );

      await conn.commit();
      return res.json({ 
        ok: true, 
        action: "entrada", 
        id: ins.insertId, 
        entrada: hhmm, 
        turno_ordem: maxTurno + 1,
        message: "Entrada registrada com sucesso!"
      });
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