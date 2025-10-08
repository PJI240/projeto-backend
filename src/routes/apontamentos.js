// src/routes/apontamentos.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = Router();

/* ===================== helpers ===================== */

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

/** Empresas acessíveis ao usuário
 *  usuarios_pessoas → (pessoa_id) → funcionarios → (empresa_id)
 *  Fallback: se não houver funcionário, usa empresa_id da própria usuarios_pessoas
 */
async function getUserEmpresaIds(userId) {
  const [rows] = await pool.query(
    `
    SELECT DISTINCT COALESCE(f.empresa_id, up.empresa_id) AS empresa_id
      FROM usuarios_pessoas up
 LEFT JOIN funcionarios f
        ON f.pessoa_id = up.pessoa_id
       AND (f.ativo = 1 OR f.ativo IS NULL)
     WHERE up.usuario_id = ?
    `,
    [userId]
  );
  return rows.map((r) => r.empresa_id).filter((v) => v != null);
}

async function resolveEmpresaContext(userId, empresaIdQuery) {
  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) throw new Error("Usuário sem vínculo a nenhuma empresa.");

  if (empresaIdQuery) {
    const id = Number(empresaIdQuery);
    if (empresas.includes(id)) return id;
    throw new Error("Empresa não autorizada.");
  }
  return empresas[0];
}

function isValidISODate(s = "") {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s));
}

function normalizeTime(hhmm) {
  if (!hhmm) return null;
  const str = String(hhmm).trim();
  // Remove segundos se existirem - mantém apenas HH:MM
  return str.split(":").slice(0, 2).join(":");
}

function isValidTimeOrNull(s) {
  if (s == null || s === "") {
    console.log("DEBUG isValidTimeOrNull - Valor nulo/vazio:", s);
    return true;
  }

  const str = String(s).trim();

  // Aceita HH:MM e HH:MM:SS
  const isValid = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(str);

  if (!isValid) {
    console.log("DEBUG isValidTimeOrNull - Formato inválido:", {
      original: s,
      string: str,
      length: str.length,
      partes: str.split(":"),
      regexTest: /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(str),
    });
  }

  return isValid;
}

function clampTurno(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

function normOrigem(s = "APONTADO") {
  const t = String(s || "").toUpperCase();
  return ["APONTADO", "IMPORTADO", "AJUSTE"].includes(t) ? t : "APONTADO";
}

function minutes(hhmm) {
  if (!hhmm) return null;
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** Garante que o funcionário pertence à empresa em questão */
async function assertFuncionarioEmpresa(conn, funcionarioId, empresaId) {
  const [[row]] = await conn.query(
    `SELECT id FROM funcionarios WHERE id = ? AND empresa_id = ? LIMIT 1`,
    [funcionarioId, empresaId]
  );
  if (!row) throw new Error("Funcionário não pertence à empresa selecionada.");
}

// Validação flexível para turnos noturnos
function validateHorarios(entrada, saida) {
  if (!entrada || !saida) return null;

  const mi = minutes(entrada);
  const mo = minutes(saida);

  if (mi === null || mo === null) return null;

  // Permite turnos noturnos (saída < entrada) mas valida diferenças absurdas
  const diffMinutos = mo < mi ? mo + 1440 - mi : mo - mi; // 1440 = minutos em 24h

  // Validações de senso comum
  if (diffMinutos < 1) {
    return "Diferença mínima de 1 minuto entre entrada e saída";
  }

  if (diffMinutos > 18 * 60) {
    // 18 horas máximo
    return "Jornada muito longa (máximo 18 horas)";
  }

  return null; // Válido
}

/* ===================== GET /api/apontamentos ===================== */
router.get("/", requireAuth, async (req, res) => {
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const { from, to, funcionario_id, origem } = req.query || {};

    if (!isValidISODate(from) || !isValidISODate(to)) {
      return res
        .status(400)
        .json({ ok: false, error: "Parâmetros 'from' e 'to' devem estar em YYYY-MM-DD." });
    }

    const params = [empresaId, from, to];
    let extra = "";
    if (funcionario_id) {
      extra += " AND funcionario_id = ? ";
      params.push(Number(funcionario_id));
    }
    if (origem) {
      extra += " AND origem = ? ";
      params.push(normOrigem(origem));
    }

    const [rows] = await pool.query(
      `
        SELECT id, empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs
          FROM apontamentos
         WHERE empresa_id = ?
           AND data BETWEEN ? AND ?
           ${extra}
         ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC
      `,
      params
    );

    return res.json({ ok: true, empresa_id: empresaId, apontamentos: rows });
  } catch (e) {
    console.error("APONT_LIST_ERR", e);
    return res
      .status(400)
      .json({ ok: false, error: e.message || "Falha ao listar apontamentos." });
  }
});

/* ===================== POST /api/apontamentos ===================== */
router.post("/", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const {
      funcionario_id,
      data,
      turno_ordem = 1,
      entrada = null,
      saida = null,
      origem = "APONTADO",
      obs = null,
    } = req.body || {};

    console.log("DEBUG POST - Body recebido:", req.body);

    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res
        .status(400)
        .json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }

    // NORMALIZAR HORÁRIOS (remover segundos)
    const entradaNormalizada = entrada ? normalizeTime(entrada) : null;
    const saidaNormalizada = saida ? normalizeTime(saida) : null;

    // VALIDAÇÃO COM DEBUG
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      console.error("DEBUG POST - Valores inválidos:", {
        entrada,
        saida,
        entradaNormalizada,
        saidaNormalizada,
        tipos: { entrada: typeof entrada, saida: typeof saida },
      });
      return res.status(400).json({
        ok: false,
        error: `Horários inválidos (formato HH:MM ou HH:MM:SS). Entrada: "${entrada}", Saída: "${saida}"`,
      });
    }

    // Validação flexível para turnos noturnos
    if (entradaNormalizada && saidaNormalizada) {
      const erro = validateHorarios(entradaNormalizada, saidaNormalizada);
      if (erro) {
        return res.status(400).json({ ok: false, error: erro });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    const [ins] = await conn.query(
      `INSERT INTO apontamentos
         (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        empresaId,
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entradaNormalizada || null,
        saidaNormalizada || null,
        normOrigem(origem),
        obs || null,
      ]
    );

    await conn.commit();
    return res.json({ ok: true, id: ins.insertId });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("APONT_CREATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res.status(409).json({
        ok: false,
        error:
          "Duplicado: já existe apontamento com mesma chave (funcionário, data, turno, origem).",
      });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao criar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== PUT /api/apontamentos/:id ===================== */
router.put("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    const {
      funcionario_id,
      data,
      turno_ordem = 1,
      entrada = null,
      saida = null,
      origem = "APONTADO",
      obs = null,
    } = req.body || {};

    console.log("DEBUG PUT - Body recebido:", req.body);

    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });
    if (!Number(funcionario_id) || !isValidISODate(data)) {
      return res.status(400).json({ ok: false, error: "Funcionário e data são obrigatórios." });
    }

    // NORMALIZAR HORÁRIOS (remover segundos)
    const entradaNormalizada = entrada ? normalizeTime(entrada) : null;
    const saidaNormalizada = saida ? normalizeTime(saida) : null;

    // VALIDAÇÃO COM DEBUG
    if (!isValidTimeOrNull(entrada) || !isValidTimeOrNull(saida)) {
      console.error("DEBUG PUT - Valores inválidos:", {
        entrada,
        saida,
        entradaNormalizada,
        saidaNormalizada,
        tipos: { entrada: typeof entrada, saida: typeof saida },
      });
      return res.status(400).json({
        ok: false,
        error: `Horários inválidos (formato HH:MM ou HH:MM:SS). Entrada: "${entrada}", Saída: "${saida}"`,
      });
    }

    // Validação flexível para turnos noturnos
    if (entradaNormalizada && saidaNormalizada) {
      const erro = validateHorarios(entradaNormalizada, saidaNormalizada);
      if (erro) {
        return res.status(400).json({ ok: false, error: erro });
      }
    }

    conn = await pool.getConnection();
    await conn.beginTransaction();

    // verifica se pertence à empresa
    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }

    await assertFuncionarioEmpresa(conn, Number(funcionario_id), empresaId);

    await conn.query(
      `UPDATE apontamentos
          SET funcionario_id = ?,
              data = ?,
              turno_ordem = ?,
              entrada = ?,
              saida = ?,
              origem = ?,
              obs = ?
        WHERE id = ?`,
      [
        Number(funcionario_id),
        data,
        clampTurno(turno_ordem),
        entradaNormalizada || null,
        saidaNormalizada || null,
        normOrigem(origem),
        obs || null,
        id,
      ]
    );

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    const msg = String(e?.message || "");
    console.error("APONT_UPDATE_ERR", e);
    if (/Duplicate entry/i.test(msg)) {
      return res
        .status(409)
        .json({ ok: false, error: "Duplicado: mesma chave (funcionário, data, turno, origem)." });
    }
    return res.status(400).json({ ok: false, error: msg || "Falha ao atualizar apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== DELETE /api/apontamentos/:id ===================== */
router.delete("/:id", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "ID inválido." });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[row]] = await conn.query(
      `SELECT id, empresa_id FROM apontamentos WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!row || row.empresa_id !== empresaId) {
      throw new Error("Apontamento não encontrado para a empresa selecionada.");
    }

    await conn.query(`DELETE FROM apontamentos WHERE id = ?`, [id]);

    await conn.commit();
    return res.json({ ok: true });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("APONT_DELETE_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao excluir apontamento." });
  } finally {
    if (conn) conn.release();
  }
});

/* ===================== POST /api/apontamentos/import ===================== */
router.post("/import", requireAuth, async (req, res) => {
  let conn;
  try {
    const empresaId = await resolveEmpresaContext(req.userId, req.query.empresa_id);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ ok: false, error: "Nenhuma linha para importar." });
    if (rows.length > 5000)
      return res.status(400).json({ ok: false, error: "Limite de 5000 linhas por importação." });

    console.log("DEBUG IMPORT - Dados recebidos:", {
      totalRows: rows.length,
      sample: rows.slice(0, 2),
    });

    conn = await pool.getConnection();
    await conn.beginTransaction();

    let inseridas = 0;
    let duplicadas = 0;
    const invalidas = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const funcionario_id = Number(r.funcionario_id);
      const data = r.data;
      const turno_ordem = clampTurno(r.turno_ordem);
      const entrada = r.entrada || null;
      const saida = r.saida || null;
      const origem = normOrigem(r.origem);
      const obs = r.obs || null;

      // NORMALIZAR HORÁRIOS
      const entradaNormalizada = entrada ? normalizeTime(entrada) : null;
      const saidaNormalizada = saida ? normalizeTime(saida) : null;

      // validações básicas
      let erro = "";
      if (!funcionario_id) {
        erro = "funcionario_id vazio";
      } else if (!isValidISODate(data)) {
        erro = "data inválida (YYYY-MM-DD)";
      } else if (!isValidTimeOrNull(entrada)) {
        console.error("DEBUG IMPORT - Entrada inválida na linha", i, ":", entrada);
        erro = "entrada inválida";
      } else if (!isValidTimeOrNull(saida)) {
        console.error("DEBUG IMPORT - Saída inválida na linha", i, ":", saida);
        erro = "saida inválida";
      } else if (entradaNormalizada && saidaNormalizada) {
        const validacao = validateHorarios(entradaNormalizada, saidaNormalizada);
        if (validacao) erro = validacao;
      }

      if (erro) {
        invalidas.push({
          index: i,
          motivo: erro,
          dados: { funcionario_id, data, entrada, saida },
        });
        continue;
      }

      try {
        await assertFuncionarioEmpresa(conn, funcionario_id, empresaId);
        await conn.query(
          `INSERT INTO apontamentos
             (empresa_id, funcionario_id, data, turno_ordem, entrada, saida, origem, obs)
           VALUES (?,?,?,?,?,?,?,?)`,
          [empresaId, funcionario_id, data, turno_ordem, entradaNormalizada, saidaNormalizada, origem, obs]
        );
        inseridas++;
      } catch (e) {
        const msg = String(e?.message || "");
        if (/Duplicate entry/i.test(msg)) {
          duplicadas++;
          continue;
        }
        invalidas.push({
          index: i,
          motivo: "erro inesperado: " + msg,
          dados: { funcionario_id, data, entrada, saida },
        });
      }
    }

    await conn.commit();
    return res.json({
      ok: true,
      resumo: { inseridas, duplicadas, invalidas: invalidas.length },
      invalidas: invalidas.slice(0, 100), // Limita para não sobrecarregar a resposta
    });
  } catch (e) {
    if (conn) await conn.rollback();
    console.error("APONT_IMPORT_ERR", e);
    return res.status(400).json({ ok: false, error: e.message || "Falha ao importar apontamentos." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;