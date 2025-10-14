// src/routes/dashboard_func.js
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
function nowUtc() { return new Date(); } // servidor em UTC

function brDateISO(d = new Date()) {
  // YYYY-MM-DD baseado em America/Sao_Paulo (UTC-3 simplificado)
  const tzOffsetMin = -3 * 60;
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
      if (ver) await conn.query(`UPDATE rep_coletores SET versao = ? WHERE id = ?`, [ver, coletorId]);
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

/* ========= alocação de NSR por CNPJ (seguro p/ concorrência) ========= */
async function allocNsr(conn, cnpj14) {
  if (!cnpj14) return null;
  const cnpj = String(cnpj14).replace(/\D/g, "").padStart(14, "0").slice(-14);

  // garante linha; UNIQUE(estabelecimento_cnpj)
  await conn.query(
    `INSERT IGNORE INTO rep_nsr (estabelecimento_cnpj, proximo_nsr) VALUES (?, 1)`,
    [cnpj]
  );

  const [[row]] = await conn.query(
    `SELECT proximo_nsr FROM rep_nsr WHERE estabelecimento_cnpj = ? FOR UPDATE`,
    [cnpj]
  );

  const nsrAtual = Number(row?.proximo_nsr || 1);
  await conn.query(
    `UPDATE rep_nsr SET proximo_nsr = proximo_nsr + 1 WHERE estabelecimento_cnpj = ?`,
    [cnpj]
  );
  return nsrAtual;
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

    // evento por linha (ENTRADA/SAIDA)
    const [evs] = await pool.query(
      `
        SELECT id, turno_ordem, evento, horario, origem, is_rep_oficial, status_tratamento,
               tz, coletor_id, nsr, dt_marcacao, dt_gravacao
          FROM apontamentos
         WHERE empresa_id = ? AND funcionario_id = ? AND data = ?
         ORDER BY horario ASC, id ASC
      `,
      [empresaId, func.id, iso]
    );

    const ultimo = evs[evs.length - 1];
    const estado = ultimo?.evento === "ENTRADA" ? "TRABALHANDO" : "FORA";

    return res.json({
      ok: true,
      empresa_id: empresaId,
      funcionario: { id: func.id, pessoa_nome: func.pessoa_nome, cargo_nome: func.cargo_nome },
      data: iso,
      escala: esc,
      apontamentos: evs,
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
 *   origem?: "APONTADO",         // forçado p/ APONTADO (oficial)
 *   tz?: "America/Sao_Paulo",
 *   coletor_identificador?: "web:platform:ua",
 *   coletor_versao?: "x.y.z"
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
    const iso = brDateISO();         // data-base local (BR)
    const hhmm = hhmmNowBR();        // HH:MM local (BR)
    const dtMarc = nowUtc();         // data/hora percebida no momento (UTC)
    const dtGrav = nowUtc();         // data/hora da gravação (UTC)
    const cnpj14 = String(func.empresa_cnpj || "").replace(/\D/g, "").padStart(14, "0").slice(-14) || null;

    const coletor_id = await getOrCreateColetorId({
      empresaId,
      identificador: req.body?.coletor_identificador,
      versao: req.body?.coletor_versao,
    });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // 1) Qual foi o último evento do dia?
    const [ult] = await conn.query(
      `SELECT id, evento, turno_ordem
         FROM apontamentos
        WHERE empresa_id=? AND funcionario_id=? AND data=?
        ORDER BY horario DESC, id DESC
        LIMIT 1`,
      [empresaId, func.id, iso]
    );

    // 2) Decidir próximo evento/turno
    let proximoEvento, turno_ordem;
    if (ult.length && ult[0].evento === "ENTRADA") {
      // próximo é SAIDA no mesmo turno
      proximoEvento = "SAIDA";
      turno_ordem = Number(ult[0].turno_ordem) || 1;
    } else {
      // sem eventos ou último foi SAIDA → abrir novo turno
      proximoEvento = "ENTRADA";
      const [[mx]] = await conn.query(
        `SELECT COALESCE(MAX(turno_ordem),0) AS m
           FROM apontamentos
          WHERE empresa_id=? AND funcionario_id=? AND data=?`,
        [empresaId, func.id, iso]
      );
      turno_ordem = Number(mx?.m || 0) + 1;
    }

    // 3) Alocar NSR oficial na batida
    const nsr = await allocNsr(conn, cnpj14);

    // 4) Hash de integridade
    const hash_sha256 = calcHash({
      estabelecimento_cnpj: cnpj14,
      funcionario_id: func.id,
      nsr,
      dt_marcacao: dtMarc,
      tz,
      dt_gravacao: dtGrav,
      coletor_id,
    });

    // 5) Inserir evento (INSERT sempre; oficiais são imutáveis)
    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, estabelecimento_cnpj, is_rep_oficial, nsr,
          dt_marcacao, tz, dt_gravacao, coletor_id, hash_sha256,
          funcionario_id, data, turno_ordem, evento, horario,
          origem, status_tratamento, origem_nsr_ref, obs)
       VALUES (?,?,?,?, ?,?,?,?,?,
               ?,?,?,?, ?,?, 'VALIDA', NULL, NULL)`,
      [
        empresaId, cnpj14, 1, nsr,
        dtMarc, tz, dtGrav, coletor_id, hash_sha256,
        func.id, iso, turno_ordem, proximoEvento, hhmm,
        origem
      ]
    );

    await conn.commit();
    return res.json({
      ok: true,
      action: proximoEvento.toLowerCase(),
      id: ins.insertId,
      evento: proximoEvento,
      horario: hhmm,
      turno_ordem,
      nsr,
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("DASH_FUNC_CLOCK_ERR", e);
    const msg = String(e?.message || "");
    if (msg.includes("imutável") || msg.includes("PTRP") || msg.includes("TRIGGER")) {
      return res.status(405).json({
        ok: false,
        error: "Política de imutabilidade bloqueou a operação. Em oficiais, usamos INSERT-only; ajustes via PTRP.",
      });
    }
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({ ok: false, error: "Conflito de duplicidade." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao registrar ponto." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;