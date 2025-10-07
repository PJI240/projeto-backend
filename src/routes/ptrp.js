// routes/ptrp.js
import { Router } from "express";
import { pool } from "../db.js";           // sua pool mysql2
import { requireAuth } from "../middlewares/auth.js"; // use seu middleware

const router = Router();

/**
 * POST /api/ptrp/ajustes
 * Fluxo: invalidar original (opcional) + criar apontamento 'AJUSTE' para destino
 * Body:
 *  {
 *    acao: "invalidar_e_criar_ajuste",
 *    apontamento_id_original: number,
 *    destino_funcionario_id: number,
 *    data: "YYYY-MM-DD",
 *    entrada?: "HH:MM",
 *    saida?: "HH:MM",
 *    justificativa: string,
 *    invalidar_original: boolean
 *  }
 */
router.post("/ajustes", requireAuth, async (req, res) => {
  const {
    acao,
    apontamento_id_original,
    destino_funcionario_id,
    data,
    entrada = null,
    saida = null,
    justificativa = "",
    invalidar_original = true,
  } = req.body || {};

  if (acao !== "invalidar_e_criar_ajuste") {
    return res.status(400).json({ ok: false, error: "Ação inválida." });
  }
  if (!apontamento_id_original || !destino_funcionario_id || !data || !justificativa) {
    return res.status(400).json({ ok: false, error: "Campos obrigatórios ausentes." });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1) Carrega e bloqueia original (FOR UPDATE)
    const [origRows] = await conn.query(
      `SELECT * FROM apontamentos WHERE id = ? FOR UPDATE`,
      [apontamento_id_original]
    );
    const original = origRows[0];
    if (!original) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: "Apontamento original não encontrado." });
    }
    if (original.status_tratamento === "INVALIDADA") {
      await conn.rollback();
      return res.status(409).json({ ok: false, error: "Apontamento já invalidado por tratamento." });
    }

    // 2) Opcional: invalidar original (sem alterar horas/NSR do oficial)
    if (invalidar_original) {
      await conn.query(
        `UPDATE apontamentos
           SET status_tratamento = 'INVALIDADA',
               trat_justificativa = ?,
               trat_usuario_id = ?,
               trat_em = NOW()
         WHERE id = ?`,
        [justificativa, req.userId || null, original.id]
      );
    }

    // 3) Criar novo apontamento de AJUSTE para o destino
    const [ins] = await conn.query(
      `INSERT INTO apontamentos
        (funcionario_id, data, turno_ordem, entrada, saida, origem,
         status_tratamento, origem_nsr_ref, trat_justificativa, trat_usuario_id, trat_em, obs)
       VALUES
        (?, ?, ?, ?, ?, 'AJUSTE',
         'VALIDA', ?, ?, ?, NOW(), ?)`,
      [
        Number(destino_funcionario_id),
        data,
        Number(original.turno_ordem || 1),
        entrada,
        saida,
        original.id,                // origem_nsr_ref aponta para o ID original
        justificativa,
        req.userId || null,
        `Ajuste criado via PTRP; origem #${original.id}.`,
      ]
    );

    // 4) Log (opcional)
    await conn.query(
      `INSERT INTO rep_eventos_sensiveis (tipo, payload, usuario_id)
       VALUES ('PTRP_AJUSTE', JSON_OBJECT(
         'apontamento_id_original', ?, 
         'ajuste_id', ?, 
         'destino_funcionario_id', ?, 
         'invalidou_original', ?
       ), ?)`,
      [original.id, ins.insertId, Number(destino_funcionario_id), !!invalidar_original, req.userId || null]
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