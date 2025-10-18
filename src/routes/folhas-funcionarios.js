// src/routes/folhas-funcionarios.js
import express from "express";
import jwt from "jsonwebtoken";
import { pool } from "../db.js";

const router = express.Router();

/* ======================= HELPERS ======================= */
const norm = (v) => (v ?? "").toString().trim();
const normStr = (v) => { const s = norm(v); return s.length ? s : null; };

/** Converte input para formato YYYY-MM */
function toYM(input) {
  const s = norm(input).toLowerCase();
  if (!s) return null;
  
  // Formato ISO: "YYYY-MM" ou "YYYY-MM-DD"
  const mIso = s.match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  if (mIso) return `${mIso[1]}-${mIso[2]}`;
  
  // Formato português: "outubro de 2025"
  const meses = {
    janeiro: "01", fevereiro: "02", março: "03", marco: "03", 
    abril: "04", maio: "05", junho: "06", julho: "07", 
    agosto: "08", setembro: "09", outubro: "10", novembro: "11", dezembro: "12"
  };
  const mBr = s.match(/(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro).*?(\d{4})/i);
  if (mBr) return `${mBr[2]}-${meses[mBr[1].toLowerCase()]}`;
  
  return null;
}

const numOrNull = (v) => {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Obtém roles do usuário */
async function getUserRoles(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT p.nome AS perfil
       FROM usuarios_perfis up
       JOIN perfis p ON p.id = up.perfil_id
       WHERE up.usuario_id = ?`,
      [userId]
    );
    return rows.map((r) => String(r.perfil || "").toLowerCase());
  } catch (error) {
    console.error("Erro ao obter roles:", error);
    return [];
  }
}

/** Verifica se é desenvolvedor */
const isDev = (roles = []) => roles.includes("desenvolvedor");

/** Obtém empresas do usuário */
async function getUserEmpresaIds(userId) {
  try {
    const [rows] = await pool.query(
      `SELECT eu.empresa_id
       FROM empresas_usuarios eu
       WHERE eu.usuario_id = ? AND eu.ativo = 1`,
      [userId]
    );
    return rows.map((r) => Number(r.empresa_id));
  } catch (error) {
    console.error("Erro ao obter empresas:", error);
    return [];
  }
}

/** Middleware de autenticação */
function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) {
      return res.status(401).json({ ok: false, error: "Não autenticado." });
    }
    
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (error) {
    return res.status(401).json({ ok: false, error: "Sessão inválida." });
  }
}

/** Valida escopo do lançamento */
async function ensureFolhaFuncionarioScope(userId, ffId) {
  const roles = await getUserRoles(userId);
  if (isDev(roles)) return true;

  const empresas = await getUserEmpresaIds(userId);
  if (!empresas.length) {
    throw new Error("Acesso negado: usuário sem empresa vinculada.");
  }

  const [[row]] = await pool.query(
    `SELECT ff.empresa_id
     FROM folhas_funcionarios ff
     WHERE ff.id = ?
     LIMIT 1`,
    [ffId]
  );
  
  if (!row) throw new Error("Registro não encontrado.");
  if (!empresas.includes(Number(row.empresa_id))) {
    throw new Error("Recurso fora do escopo do usuário.");
  }
  
  return true;
}

/** Encontra ou cria folha para competência */
async function findOrCreateFolha(competencia, empresaId) {
  if (!competencia || !empresaId) {
    throw new Error("Competência e empresa são obrigatórios.");
  }

  // Tenta encontrar folha existente
  const [[folhaExistente]] = await pool.query(
    `SELECT id, empresa_id, competencia, status 
     FROM folhas 
     WHERE competencia = ? AND empresa_id = ? 
     LIMIT 1`,
    [competencia, empresaId]
  );

  if (folhaExistente) {
    return folhaExistente;
  }

  // Cria nova folha
  try {
    const [result] = await pool.query(
      `INSERT INTO folhas (empresa_id, competencia, status, criado_em) 
       VALUES (?, ?, 'aberta', NOW())`,
      [empresaId, competencia]
    );
    
    return {
      id: result.insertId,
      empresa_id: empresaId,
      competencia,
      status: 'aberta'
    };
  } catch (error) {
    console.error("Erro ao criar folha:", error);
    throw new Error("Falha ao criar folha para a competência.");
  }
}

/* ======================= ROTAS ======================= */
router.use(requireAuth);

/**
 * GET /api/folhas-funcionarios
 * Lista lançamentos com filtros
 */
router.get("/folhas-funcionarios", async (req, res) => {
  try {
    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);
    const scope = String(req.query.scope || "mine").toLowerCase();

    const from = toYM(req.query.from);
    const to = toYM(req.query.to);
    const funcionarioId = req.query.funcionario_id ? Number(req.query.funcionario_id) : null;
    const q = normStr(req.query.q);

    // Construir WHERE clause
    const where = [];
    const params = [];

    // Filtro por escopo (empresas do usuário)
    if (!dev || scope !== "all") {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length) {
        return res.json({ ok: true, items: [], scope: "mine" });
      }
      where.push(`ff.empresa_id IN (${empresas.map(() => "?").join(",")})`);
      params.push(...empresas);
    }

    // Filtros adicionais
    if (from) {
      where.push(`f.competencia >= ?`);
      params.push(from);
    }
    if (to) {
      where.push(`f.competencia <= ?`);
      params.push(to);
    }
    if (funcionarioId) {
      where.push(`ff.funcionario_id = ?`);
      params.push(funcionarioId);
    }
    if (q) {
      where.push(`(
        CAST(ff.id AS CHAR) LIKE CONCAT('%', ?, '%')
        OR UPPER(COALESCE(p.nome, CONCAT('#', fu.id))) LIKE UPPER(CONCAT('%', ?, '%'))
        OR f.competencia LIKE CONCAT('%', ?, '%')
      )`);
      params.push(q, q, q);
    }

    const query = `
      SELECT
        ff.id,
        ff.folha_id,
        ff.funcionario_id,
        f.competencia,
        COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
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
        f.empresa_id
      FROM folhas_funcionarios ff
      JOIN folhas f ON f.id = ff.folha_id
      JOIN funcionarios fu ON fu.id = ff.funcionario_id
      LEFT JOIN pessoas p ON p.id = fu.pessoa_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY f.competencia DESC, ff.id DESC
    `;

    const [rows] = await pool.query(query, params);

    return res.json({ 
      ok: true, 
      items: rows, 
      scope: dev && scope === "all" ? "all" : "mine",
      total: rows.length
    });

  } catch (error) {
    console.error("ERRO_LISTAR_FOLHAS_FUNCIONARIOS:", error);
    return res.status(400).json({ 
      ok: false, 
      error: error.message || "Falha ao listar lançamentos." 
    });
  }
});

/**
 * GET /api/folhas-funcionarios/:id
 * Obtém um lançamento específico
 */
router.get("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    await ensureFolhaFuncionarioScope(req.userId, id);

    const [[row]] = await pool.query(
      `SELECT
          ff.id,
          ff.folha_id,
          ff.funcionario_id,
          f.competencia,
          COALESCE(p.nome, CONCAT('#', fu.id)) AS funcionario_nome,
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
          f.empresa_id
        FROM folhas_funcionarios ff
        JOIN folhas f ON f.id = ff.folha_id
        JOIN funcionarios fu ON fu.id = ff.funcionario_id
        LEFT JOIN pessoas p ON p.id = fu.pessoa_id
        WHERE ff.id = ?
        LIMIT 1`,
      [id]
    );

    if (!row) {
      return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    }

    return res.json({ ok: true, item: row });

  } catch (error) {
    console.error("ERRO_OBTER_FOLHA_FUNCIONARIO:", error);
    return res.status(400).json({ 
      ok: false, 
      error: error.message || "Falha ao obter registro." 
    });
  }
});

/**
 * POST /api/folhas-funcionarios
 * Cria novo lançamento
 */
router.post("/folhas-funcionarios", async (req, res) => {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    const roles = await getUserRoles(req.userId);
    const dev = isDev(roles);

    let { folha_id, competencia, funcionario_id } = req.body || {};
    folha_id = folha_id ? Number(folha_id) : null;
    competencia = toYM(competencia);
    funcionario_id = Number(funcionario_id);

    // Validações básicas
    if (!funcionario_id) {
      throw new Error("Informe funcionario_id.");
    }
    if (!competencia && !folha_id) {
      throw new Error("Informe competencia (YYYY-MM) ou folha_id.");
    }

    let empresa_id;
    let folha_id_final = folha_id;

    // Resolver folha_id se não fornecido
    if (!folha_id_final) {
      const empresas = await getUserEmpresaIds(req.userId);
      if (!empresas.length && !dev) {
        throw new Error("Usuário sem empresa vinculada.");
      }

      // Usa primeira empresa ou permite desenvolvedor escolher
      const empresaAlvo = dev && req.body.empresa_id 
        ? Number(req.body.empresa_id) 
        : empresas[0];

      if (!empresaAlvo) {
        throw new Error("Não foi possível determinar a empresa.");
      }

      const folha = await findOrCreateFolha(competencia, empresaAlvo);
      folha_id_final = folha.id;
      empresa_id = folha.empresa_id;
    } else {
      // Validar folha existente
      const [[folhaInfo]] = await pool.query(
        `SELECT id, empresa_id, competencia FROM folhas WHERE id = ? LIMIT 1`,
        [folha_id_final]
      );
      
      if (!folhaInfo) {
        throw new Error("Folha inexistente.");
      }

      // Validar escopo
      if (!dev) {
        const empresas = await getUserEmpresaIds(req.userId);
        if (!empresas.includes(Number(folhaInfo.empresa_id))) {
          throw new Error("Folha fora do escopo do usuário.");
        }
      }

      empresa_id = folhaInfo.empresa_id;
      competencia = folhaInfo.competencia; // Usa competência da folha
    }

    // Verificar se já existe lançamento para este funcionário na folha
    const [[existente]] = await pool.query(
      `SELECT id FROM folhas_funcionarios 
       WHERE folha_id = ? AND funcionario_id = ? 
       LIMIT 1`,
      [folha_id_final, funcionario_id]
    );

    if (existente) {
      throw new Error("Já existe um lançamento para este funcionário na folha selecionada.");
    }

    // Preparar payload
    const payload = {
      empresa_id,
      folha_id: folha_id_final,
      funcionario_id,
      horas_normais: numOrNull(req.body?.horas_normais),
      he50_horas: numOrNull(req.body?.he50_horas),
      he100_horas: numOrNull(req.body?.he100_horas),
      valor_base: numOrNull(req.body?.valor_base),
      valor_he50: numOrNull(req.body?.valor_he50),
      valor_he100: numOrNull(req.body?.valor_he100),
      descontos: numOrNull(req.body?.descontos),
      proventos: numOrNull(req.body?.proventos),
      total_liquido: numOrNull(req.body?.total_liquido),
      inconsistencias: Number(req.body?.inconsistencias || 0),
    };

    // Calcular total líquido se não fornecido
    if (payload.total_liquido === null) {
      const total = 
        (payload.valor_base || 0) +
        (payload.valor_he50 || 0) +
        (payload.valor_he100 || 0) +
        (payload.proventos || 0) -
        (payload.descontos || 0);
      payload.total_liquido = total;
    }

    // Inserir no banco
    const [result] = await connection.query(
      `INSERT INTO folhas_funcionarios (
        empresa_id, folha_id, funcionario_id, horas_normais, he50_horas, he100_horas,
        valor_base, valor_he50, valor_he100, descontos, proventos, total_liquido, inconsistencias
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.empresa_id,
        payload.folha_id,
        payload.funcionario_id,
        payload.horas_normais,
        payload.he50_horas,
        payload.he100_horas,
        payload.valor_base,
        payload.valor_he50,
        payload.valor_he100,
        payload.descontos,
        payload.proventos,
        payload.total_liquido,
        payload.inconsistencias
      ]
    );

    await connection.commit();

    return res.json({ 
      ok: true, 
      id: result.insertId,
      folha_id: folha_id_final,
      competencia: competencia
    });

  } catch (error) {
    if (connection) await connection.rollback();
    console.error("ERRO_CRIAR_FOLHA_FUNCIONARIO:", error);
    
    let mensagemErro = error.message || "Falha ao criar lançamento.";
    
    // Tratamento de erros específicos
    if (error.code === 'ER_DUP_ENTRY') {
      mensagemErro = "Já existe um lançamento para este funcionário na folha.";
    } else if (error.code === 'ER_NO_REFERENCED_ROW') {
      mensagemErro = "Funcionário ou folha não encontrado.";
    }
    
    return res.status(400).json({ ok: false, error: mensagemErro });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PUT /api/folhas-funcionarios/:id
 * Atualiza lançamento existente
 */
router.put("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    await ensureFolhaFuncionarioScope(req.userId, id);

    const camposPermitidos = [
      'funcionario_id', 'horas_normais', 'he50_horas', 'he100_horas',
      'valor_base', 'valor_he50', 'valor_he100', 'descontos', 
      'proventos', 'total_liquido', 'inconsistencias'
    ];

    const sets = [];
    const params = [];

    // Construir SET dinamicamente
    for (const campo of camposPermitidos) {
      if (req.body?.hasOwnProperty(campo)) {
        if (campo === 'funcionario_id') {
          sets.push(`${campo} = ?`);
          params.push(Number(req.body[campo]));
        } else if (campo === 'inconsistencias') {
          sets.push(`${campo} = ?`);
          params.push(Number(req.body[campo] || 0));
        } else {
          sets.push(`${campo} = ?`);
          params.push(numOrNull(req.body[campo]));
        }
      }
    }

    if (!sets.length) {
      return res.json({ ok: true, changed: 0 });
    }

    // Recalcular total_liquido se campos monetários foram alterados
    const camposMonetarios = ['valor_base', 'valor_he50', 'valor_he100', 'descontos', 'proventos'];
    const camposAlterados = Object.keys(req.body || {});
    const precisaRecalcular = camposMonetarios.some(campo => camposAlterados.includes(campo));

    if (precisaRecalcular && !camposAlterados.includes('total_liquido')) {
      // Buscar valores atuais
      const [[atual]] = await pool.query(
        `SELECT valor_base, valor_he50, valor_he100, descontos, proventos 
         FROM folhas_funcionarios WHERE id = ?`,
        [id]
      );

      // Aplicar alterações nos valores
      const valores = { ...atual, ...req.body };
      const novoTotal = 
        (numOrNull(valores.valor_base) || 0) +
        (numOrNull(valores.valor_he50) || 0) +
        (numOrNull(valores.valor_he100) || 0) +
        (numOrNull(valores.proventos) || 0) -
        (numOrNull(valores.descontos) || 0);

      sets.push("total_liquido = ?");
      params.push(novoTotal);
    }

    params.push(id);

    const [result] = await pool.query(
      `UPDATE folhas_funcionarios SET ${sets.join(", ")} WHERE id = ?`,
      params
    );

    return res.json({ 
      ok: true, 
      changed: result.affectedRows,
      affectedRows: result.affectedRows 
    });

  } catch (error) {
    console.error("ERRO_ATUALIZAR_FOLHA_FUNCIONARIO:", error);
    return res.status(400).json({ 
      ok: false, 
      error: error.message || "Falha ao atualizar lançamento." 
    });
  }
});

/**
 * DELETE /api/folhas-funcionarios/:id
 * Remove lançamento
 */
router.delete("/folhas-funcionarios/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    await ensureFolhaFuncionarioScope(req.userId, id);

    const [result] = await pool.query(
      `DELETE FROM folhas_funcionarios WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ ok: false, error: "Registro não encontrado." });
    }

    return res.json({ 
      ok: true, 
      message: "Registro excluído com sucesso.",
      affectedRows: result.affectedRows 
    });

  } catch (error) {
    console.error("ERRO_EXCLUIR_FOLHA_FUNCIONARIO:", error);
    
    if (error.code === "ER_ROW_IS_REFERENCED_2" || error.errno === 1451) {
      return res.status(409).json({ 
        ok: false, 
        error: "Não é possível excluir: registro referenciado por outras entidades." 
      });
    }
    
    return res.status(400).json({ 
      ok: false, 
      error: error.message || "Falha ao excluir lançamento." 
    });
  }
});

export default router;