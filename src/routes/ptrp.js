// routes/ptrp.js
import { Router } from "express";
import { pool } from "../db.js";
// Se você já tem o middleware, use sua versão e remova o local abaixo:
// import requireAuth from "../middleware/requireAuth.js";
// ou: import { requireAuth } from "../middleware/requireAuth.js";

import jwt from "jsonwebtoken"; // apenas se usar requireAuth local

const router = Router();

/* ========= requireAuth (local, opcional) ========= */
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

/* ========= helpers ========= */
function isISODate(s = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}
function isHHMM(s = "") {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s).trim());
}
function normEvento(e = "") {
  const t = String(e || "").toUpperCase();
  return t === "ENTRADA" || t === "SAIDA" ? t : null;
}
function clampTurno(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}
async function getEmpresaIdDeFuncionario(conn, funcionarioId) {
  const [[r]] = await conn.query(
    `SELECT empresa_id FROM funcionarios WHERE id = ? LIMIT 1`,
    [Number(funcionarioId)]
  );
  return r?.empresa_id || null;
}
async function usuarioTemAcessoEmpresas(conn, userId, empresaIds = []) {
  if (!empresaIds.length) return false;
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS cnt
       FROM empresas_usuarios
      WHERE usuario_id = ?
        AND empresa_id IN (${empresaIds.map(() => "?").join(",")})`,
    [Number(userId), ...empresaIds.map(Number)]
  );
  return (rows?.[0]?.cnt ?? 0) > 0;
}

/*
  POST /api/ptrp/ajustes

  Body:
  {
    acao: "invalidar_e_criar_ajuste",
    apontamento_id_original: number,
    destino_funcionario_id: number,
    data: "YYYY-MM-DD",
    evento: "ENTRADA" | "SAIDA",
    horario: "HH:MM",
    justificativa: string,
    invalidar_original: boolean,
    turno_ordem?: number         // (opcional) se não enviar, usa do original
  }
*/
router.post("/ajustes", requireAuth, async (req, res) => {
  const {
    acao,
    apontamento_id_original,
    destino_funcionario_id,
    data,
    evento,
    horario,
    justificativa = "",
    invalidar_original = true,
    turno_ordem,
  } = req.body || {};

  // ===== validações de payload =====
  if (acao !== "invalidar_e_criar_ajuste") {
    return res.status(400).json({ ok: false, error: "Ação inválida." });
  }
  if (!apontamento_id_original || !destino_funcionario_id || !data || !evento || !horario) {
    return res.status(400).json({ ok: false, error: "Campos obrigatórios ausentes." });
  }
  if (!isISODate(data)) {
    return res.status(400).json({ ok: false, error: "Data inválida (use YYYY-MM-DD)." });
  }
  const ev = normEvento(evento);
  if (!ev) {
    return res.status(400).json({ ok: false, error: "Evento deve ser ENTRADA ou SAIDA." });
  }
  if (!isHHMM(horario)) {
    return res.status(400).json({ ok: false, error: "Horário inválido (use HH:MM)." });
  }
  if (!String(justificativa || "").trim()) {
    return res.status(400).json({ ok: false, error: "Justificativa é obrigatória." });
  }

  const userId = Number(req.userId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ===== 1) Carrega e bloqueia original =====
    const [[original]] = await conn.query(
      `SELECT *
         FROM apontamentos
        WHERE id = ?
        FOR UPDATE`,
      [Number(apontamento_id_original)]
    );
    if (!original) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Apontamento original não encontrado." });
    }
    if (original.status_tratamento === "INVALIDADA") {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Original já está invalidado." });
    }

    // ===== 2) Escopo de empresa: usuário precisa ter acesso a ambas =====
    const empresa_original_id = Number(original.empresa_id);
    const empresa_destino_id = await getEmpresaIdDeFuncionario(conn, Number(destino_funcionario_id));
    if (!empresa_destino_id) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Funcionário de destino não encontrado." });
    }

    const okEscopo = await usuarioTemAcessoEmpresas(conn, userId, [
      empresa_original_id,
      empresa_destino_id,
    ]);
    if (!okEscopo) {
      await conn.rollback();
      return res.status(403).json({ ok: false, error: "Sem permissão para operar nessas empresas." });
    }

    // ===== 3) (Opcional) invalidar original =====
    if (invalidar_original) {
      // Só marca tratamento; não altera conteúdo do original (imutável).
      await conn.query(
        `UPDATE apontamentos
            SET status_tratamento = 'INVALIDADA',
                trat_justificativa = ?,
                trat_usuario_id = ?,
                trat_em = NOW()
          WHERE id = ?`,
        [String(justificativa).trim(), userId || null, Number(original.id)]
      );
    }

    // ===== 4) Criar novo evento AJUSTE no destino =====
    // Regras: PTRP -> is_rep_oficial = 0; nsr = NULL; origem = 'AJUSTE'
    const turno = turno_ordem ? clampTurno(turno_ordem) : clampTurno(original.turno_ordem || 1);

    // Evita duplicidade lógica (mesmo destino, data, turno, evento, horário, origem)
    const [dup] = await conn.query(
      `SELECT id FROM apontamentos
        WHERE empresa_id=? AND funcionario_id=? AND data=? AND turno_ordem=?
          AND evento=? AND horario=? AND origem='AJUSTE'
        LIMIT 1`,
      [
        empresa_destino_id,
        Number(destino_funcionario_id),
        String(data),
        turno,
        ev,
        String(horario).trim(),
      ]
    );
    if (dup.length) {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Já existe um ajuste idêntico." });
    }

    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, estabelecimento_cnpj, is_rep_oficial, nsr,
          dt_marcacao, tz, dt_gravacao, coletor_id, hash_sha256,
          funcionario_id, data, turno_ordem, evento, horario,
          origem, status_tratamento, origem_nsr_ref,
          trat_justificativa, trat_usuario_id, trat_em, obs)
       VALUES
         (?, NULL, 0, NULL,
          NULL, NULL, NOW(), NULL, NULL,
          ?, ?, ?, ?, ?,
          'AJUSTE', 'VALIDA', ?,
          ?, ?, NOW(), ?)`,
      [
        empresa_destino_id,
        Number(destino_funcionario_id),
        String(data),
        turno,
        ev,
        String(horario).trim(),
        Number(original.id),
        String(justificativa).trim(),
        userId || null,
        `Ajuste criado via PTRP; origem #${original.id}.`,
      ]
    );

    // ===== 5) Log sensível =====
    await conn.query(
      `INSERT INTO rep_eventos_sensiveis (tipo, payload, usuario_id)
       VALUES (
         'PTRP_AJUSTE',
         JSON_OBJECT(
           'apontamento_id_original', ?,
           'ajuste_id', ?,
           'destino_funcionario_id', ?,
           'empresa_original_id', ?,
           'empresa_destino_id', ?,
           'invalidou_original', ?,
           'evento', ?,
           'horario', ?
         ),
         ?
       )`,
      [
        Number(original.id),
        Number(ins.insertId),
        Number(destino_funcionario_id),
        empresa_original_id,
        empresa_destino_id,
        !!invalidar_original,
        ev,
        String(horario).trim(),
        userId || null,
      ]
    );

    await conn.commit();
    return res.json({
      ok: true,
      ajuste_id: ins.insertId,
      original_id: original.id,
      invalidado: !!invalidar_original,
      msg: "Tratamento aplicado.",
    });
  } catch (e) {
    await conn.rollback();
    console.error("PTRP ajustes error:", e);
    return res.status(500).json({ ok: false, error: "Falha ao aplicar tratamento." });
  } finally {
    conn.release();
  }
});

export default router;