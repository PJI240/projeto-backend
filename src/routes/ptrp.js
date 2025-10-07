// routes/ptrp.js
import { Router } from "express";
import { pool } from "../db.js";

// ✅ Middleware de autenticação (use a forma que você realmente exporta)
// import requireAuth from "../middleware/requireAuth.js";    // se for export default
import { requireAuth } from "../middleware/requireAuth.js";   // se for export nomeado

const router = Router();

/*
  POST /api/ptrp/ajustes
  Fluxo: (opcional) invalidar original + criar apontamento "AJUSTE" para destino

  Body:
  {
    acao: "invalidar_e_criar_ajuste",
    apontamento_id_original: number,
    destino_funcionario_id: number,
    data: "YYYY-MM-DD",
    entrada?: "HH:MM",
    saida?: "HH:MM",
    justificativa: string,
    invalidar_original: boolean
  }
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

  // ===== validações básicas de payload =====
  if (acao !== "invalidar_e_criar_ajuste") {
    return res.status(400).json({ ok: false, error: "Ação inválida." });
  }
  if (!apontamento_id_original || !destino_funcionario_id || !data || !justificativa?.trim()) {
    return res.status(400).json({ ok: false, error: "Campos obrigatórios ausentes." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data))) {
    return res.status(400).json({ ok: false, error: "Data inválida (use YYYY-MM-DD)." });
  }
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (entrada && !timeRegex.test(String(entrada))) {
    return res.status(400).json({ ok: false, error: "Entrada inválida (use HH:MM)." });
  }
  if (saida && !timeRegex.test(String(saida))) {
    return res.status(400).json({ ok: false, error: "Saída inválida (use HH:MM)." });
  }

  const userId = req.userId; // ✅ definido pelo requireAuth (payload.sub)

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ===== 1) Carrega e bloqueia original (FOR UPDATE) =====
    const [origRows] = await conn.query(
      `SELECT a.*
         FROM apontamentos a
        WHERE a.id = ?
        FOR UPDATE`,
      [Number(apontamento_id_original)]
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

    // ===== 2) Checagem de escopo: usuário precisa ter acesso à empresa do original e do destino =====
    // Pressupõe:
    // - tabela funcionarios (id, empresa_id, ...)
    // - tabela empresas_usuarios (empresa_id, usuario_id) para escopo multi-tenant
    const [escopoRows] = await conn.query(
      `
      SELECT
        (SELECT f.empresa_id
           FROM funcionarios f
           JOIN apontamentos a2 ON a2.funcionario_id = f.id
          WHERE a2.id = ?
          LIMIT 1) AS empresa_original_id,
        (SELECT f2.empresa_id
           FROM funcionarios f2
          WHERE f2.id = ?
          LIMIT 1) AS empresa_destino_id
      `,
      [Number(original.id), Number(destino_funcionario_id)]
    );
    const empresa_original_id = escopoRows?.[0]?.empresa_original_id;
    const empresa_destino_id = escopoRows?.[0]?.empresa_destino_id;

    if (!empresa_original_id || !empresa_destino_id) {
      await conn.rollback();
      return res.status(400).json({ ok: false, error: "Empresa do funcionário não encontrada." });
    }

    // Usuário precisa estar vinculado às duas empresas
    const [authRows] = await conn.query(
      `
      SELECT COUNT(*) AS cnt
        FROM empresas_usuarios eu
       WHERE eu.usuario_id = ?
         AND eu.empresa_id IN (?, ?)
      `,
      [Number(userId), Number(empresa_original_id), Number(empresa_destino_id)]
    );
    if ((authRows?.[0]?.cnt ?? 0) < 1) {
      await conn.rollback();
      return res.status(403).json({ ok: false, error: "Sem permissão para operar nessas empresas." });
    }

    // ===== 3) Opcional: invalidar original =====
    if (invalidar_original) {
      await conn.query(
        `UPDATE apontamentos
            SET status_tratamento = 'INVALIDADA',
                trat_justificativa = ?,
                trat_usuario_id = ?,
                trat_em = NOW()
          WHERE id = ?`,
        [String(justificativa).trim(), Number(userId) || null, Number(original.id)]
      );
    }

    // ===== 4) Criar novo apontamento de AJUSTE para o destino =====
    // Campos existentes em apontamentos segundo nosso padrão:
    // (id, funcionario_id, data, turno_ordem, entrada, saida, origem, origem_nsr_ref, status_tratamento,
    //  trat_justificativa, trat_usuario_id, trat_em, obs, ...)
    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (funcionario_id, data, turno_ordem, entrada, saida, origem,
          status_tratamento, origem_nsr_ref, trat_justificativa, trat_usuario_id, trat_em, obs)
       VALUES
         (?, ?, ?, ?, ?, 'AJUSTE',
          'VALIDA', ?, ?, ?, NOW(), ?)`,
      [
        Number(destino_funcionario_id),
        String(data),
        Number(original.turno_ordem || 1),
        entrada, // pode ser null
        saida,   // pode ser null
        Number(original.id),                     // origem_nsr_ref referencia o original
        String(justificativa).trim(),
        Number(userId) || null,
        `Ajuste criado via PTRP; origem #${original.id}.`,
      ]
    );

    // ===== 5) Log sensível (opcional) =====
    // rep_eventos_sensiveis(tipo, payload, usuario_id)
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
           'invalidou_original', ?
         ),
         ?
       )`,
      [
        Number(original.id),
        Number(ins.insertId),
        Number(destino_funcionario_id),
        Number(empresa_original_id),
        Number(empresa_destino_id),
        Boolean(invalidar_original),
        Number(userId) || null,
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