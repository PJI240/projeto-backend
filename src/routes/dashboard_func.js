import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db.js";

const router = Router();

/* ========== auth básico ========== */
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

/* ========== helpers comuns ========== */
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
function nowUtc() {
  // data/hora do servidor (UTC) em Date
  return new Date();
}
function brDateISO(d = new Date()) {
  // Apenas a data-base (YYYY-MM-DD) em America/Sao_Paulo
  const tzOffsetMin = -3 * 60; // UTC-3 (ajuste simples)
  const dd = new Date(d.getTime());
  dd.setMinutes(dd.getMinutes() + dd.getTimezoneOffset() + tzOffsetMin);
  return `${dd.getFullYear()}-${pad2(dd.getMonth() + 1)}-${pad2(dd.getDate())}`;
}
function hhmmNowBR() {
  const tzOffsetMin = -3 * 60;
  const dd = new Date();
  dd.setMinutes(dd.getMinutes() + dd.getTimezoneOffset() + tzOffsetMin);
  return `${pad2(dd.getHours())}:${pad2(dd.getMinutes())}`;
}

/* ========= funcionário do usuário na empresa ========= */
async function getFuncionarioDoUsuario(empresaId, userId) {
  const [rows] = await pool.query(
    `
    SELECT
      f.id,
      p.nome AS pessoa_nome,
      c.nome AS cargo_nome,
      e.cnpj AS empresa_cnpj
    FROM empresas_usuarios eu
    JOIN usuarios_pessoas up
      ON up.usuario_id = eu.usuario_id
     AND up.empresa_id = eu.empresa_id
    JOIN funcionarios f
      ON f.pessoa_id  = up.pessoa_id
     AND f.empresa_id = eu.empresa_id
    LEFT JOIN pessoas p ON p.id = f.pessoa_id
    LEFT JOIN cargos  c ON c.id = f.cargo_id
    LEFT JOIN empresas e ON e.id = eu.empresa_id
    WHERE eu.usuario_id = ?
      AND eu.empresa_id = ?
      AND eu.ativo = 1
    ORDER BY COALESCE(f.ativo, 1) DESC, f.id ASC
    LIMIT 1
    `,
    [userId, empresaId]
  );
  return rows[0] || null;
}

/* ========= coletor (REP-P) ========= */
async function getOrCreateColetorId({ empresaId, identificador, versao }) {
  if (!identificador) return null;
  const idf = String(identificador).slice(0, 120);
  const ver = versao ? String(versao).slice(0, 40) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r1] = await conn.query(
      `SELECT id FROM rep_coletores WHERE identificador = ? LIMIT 1`,
      [idf]
    );
    if (r1.length) {
      const coletorId = r1[0].id;
      // opcional: atualiza versão se mudou
      if (ver) {
        await conn.query(`UPDATE rep_coletores SET versao = ? WHERE id = ?`, [ver, coletorId]);
      }
      await conn.commit();
      return coletorId;
    }

    const [ins] = await conn.query(
      `INSERT INTO rep_coletores (empresa_id, identificador, versao, ativo)
       VALUES (?, ?, ?, 1)`,
      [empresaId, idf, ver]
    );
    await conn.commit();
    return ins.insertId;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/* ========= hash canônico ========= */
function calcHash({ estabelecimento_cnpj, funcionario_id, nsr, dt_marcacao, tz, dt_gravacao, coletor_id }) {
  // Canon: CNPJ14|FUNCID|NSR|DT_MARCACAO_ISO|TZ|DT_GRAVACAO_ISO|COLETORID
  const cnpj14 = String(estabelecimento_cnpj || "").replace(/\D/g, "").padStart(14, "0").slice(-14);
  const parts = [
    cnpj14,
    String(funcionario_id || ""),
    String(nsr || ""),
    dt_marcacao ? new Date(dt_marcacao).toISOString() : "",
    String(tz || ""),
    dt_gravacao ? new Date(dt_gravacao).toISOString() : "",
    String(coletor_id || ""),
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

/* ========== GET /api/dashboard_func/hoje ========== */
router.get("/hoje", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário." });

    const iso = brDateISO();

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
        SELECT id, turno_ordem, entrada, saida, origem, is_rep_oficial, status_tratamento,
               tz, coletor_id, nsr, dt_marcacao, dt_gravacao
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
      funcionario: { id: func.id, pessoa_nome: func.pessoa_nome, cargo_nome: func.cargo_nome },
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
 * Body esperado (do front):
 * {
 *   empresa_id?: number,
 *   origem: "APONTADO",
 *   tz: "America/Sao_Paulo",
 *   coletor_identificador: "web:platform:ua",
 *   coletor_versao?: "xx"
 * }
 */
router.post("/clock", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.body?.empresa_id);
    const func = await getFuncionarioDoUsuario(empresaId, req.userId);
    if (!func) return res.status(404).json({ ok: false, error: "Funcionário não encontrado para este usuário." });

    const tz = String(req.body?.tz || "America/Sao_Paulo");
    const origem = "APONTADO"; // oficial
    const entradaHHMM = hhmmNowBR();
    const iso = brDateISO();           // data-base (America/Sao_Paulo)
    const dtMarc = nowUtc();           // percepção do cliente não é confiável; usamos servidor UTC para registrar
    const dtGrav = nowUtc();
    const cnpj14 = String(func.empresa_cnpj || "").replace(/\D/g, "").padStart(14, "0").slice(-14) || null;

    // valida HH:MM
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(entradaHHMM)) {
      return res.status(400).json({ ok: false, error: `Formato de hora inválido: ${entradaHHMM}` });
    }

    // resolve coletor
    const coletor_id = await getOrCreateColetorId({
      empresaId,
      identificador: req.body?.coletor_identificador,
      versao: req.body?.coletor_versao,
    });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // carrega apontamentos de hoje
    const [aps] = await conn.query(
      `SELECT id, turno_ordem, entrada, saida, origem
         FROM apontamentos
        WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
        ORDER BY turno_ordem ASC, id ASC`,
      [empresaId, func.id, iso]
    );

    const aberto = aps.find((a) => a.entrada && !a.saida);

    if (aberto) {
      // ========= fechar turno aberto =========
      // ATENÇÃO aos triggers: se você bloqueou update de oficiais,
      // permita alteração de SAÍDA quando OLD.saida IS NULL.
      await conn.query(
        `UPDATE apontamentos
            SET saida = ?, dt_gravacao = ?, tz = ?
          WHERE id = ?`,
        [entradaHHMM, dtGrav, tz, aberto.id]
      );
      await conn.commit();
      return res.json({ ok: true, action: "saida", id: aberto.id, saida: entradaHHMM });
    } else {
      // ========= criar novo turno (entrada) =========
      const maxTurno = aps.reduce((m, a) => Math.max(m, Number(a.turno_ordem || 1)), 0) || 0;

      // previne duplicidade lógica do mesmo turno/origem
      const [dup] = await conn.query(
        `SELECT id FROM apontamentos
          WHERE empresa_id = ? AND funcionario_id = ? AND data = ? AND turno_ordem = ? AND origem = ?`,
        [empresaId, func.id, iso, maxTurno + 1, origem]
      );
      if (dup.length) {
        throw new Error("Já existe um apontamento para este turno.");
      }

      // NSR: pode ficar NULL aqui; normalmente é atribuído por gerador AFD (marcações)
      const nsr = null;

      // calcula hash com campos canônicos (mesmo com nsr nulo)
      const hash_sha256 = calcHash({
        estabelecimento_cnpj: cnpj14,
        funcionario_id: func.id,
        nsr,
        dt_marcacao: dtMarc,
        tz,
        dt_gravacao: dtGrav,
        coletor_id,
      });

      const [ins] = await conn.query(
        `INSERT INTO apontamentos
           (empresa_id, funcionario_id, data, turno_ordem,
            entrada, saida, origem,
            is_rep_oficial,
            estabelecimento_cnpj, nsr,
            tz, dt_marcacao, dt_gravacao, coletor_id, hash_sha256,
            status_tratamento, obs)
         VALUES (?,?,?,?,?,
                 ?,?,
                 1,
                 ?,?,
                 ?,?,?,?,?,
                 'VALIDA', NULL)`,
        [
          empresaId, func.id, iso, maxTurno + 1,
          entradaHHMM, null, origem,
          cnpj14, nsr,
          tz, dtMarc, dtGrav, coletor_id, hash_sha256,
        ]
      );

      await conn.commit();
      return res.json({
        ok: true,
        action: "entrada",
        id: ins.insertId,
        entrada: entradaHHMM,
        turno_ordem: maxTurno + 1,
      });
    }
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("DASH_FUNC_CLOCK_ERR", e);
    const msg = String(e?.message || "");
    // 45000 = erro de trigger custom (ex.: imutabilidade). Informe melhor:
    if (msg.includes("imutável") || msg.includes("PTRP") || msg.includes("TRIGGER")) {
      return res.status(405).json({
        ok: false,
        error: "Política de imutabilidade do apontamento oficial bloqueou a operação. Ajuste o trigger para permitir preencher a saída quando ela estiver vazia (OLD.saida IS NULL).",
      });
    }
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade: já existe um registro igual." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao registrar ponto." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;