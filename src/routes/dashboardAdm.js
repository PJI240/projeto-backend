import { Router } from "express";
import { pool } from "../db.js";

const router = Router();

function mustBeAuthed(req, res, next) {
  if (!req.userId) return res.status(401).json({ ok: false, error: "Não autenticado." });
  next();
}

async function getEmpresaIdsByUser(userId) {
  const [rows] = await pool.query(
    `SELECT empresa_id FROM empresas_usuarios WHERE usuario_id = ? AND ativo = 1`,
    [userId]
  );
  return rows.map((r) => r.empresa_id);
}

const pad = (n) => String(n).padStart(2, "0");
const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function weekRange() {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const seg = new Date(today); seg.setDate(today.getDate() - dow);
  const dom = new Date(seg);   dom.setDate(seg.getDate() + 6);
  return { from: toISO(seg), to: toISO(dom) };
}

async function fetchFuncionarios(empresaIds, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT f.id, f.empresa_id, f.ativo, p.nome AS pessoa_nome, c.nome AS cargo_nome
      FROM funcionarios f
      JOIN pessoas     p ON p.id = f.pessoa_id
      LEFT JOIN cargos c ON c.id = f.cargo_id
     WHERE f.empresa_id IN (?)
       ${apenasAtivos ? "AND f.ativo = 1" : ""}
     ORDER BY p.nome ASC
    `,
    [empresaIds]
  );
  return rows;
}

async function fetchEscalas(empresaIds, from, to, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    SELECT e.id,
           e.empresa_id,
           e.funcionario_id,
           DATE_FORMAT(e.data, '%Y-%m-%d') AS data,
           e.turno_ordem,
           TIME_FORMAT(e.entrada, '%H:%i')  AS entrada,
           TIME_FORMAT(e.saida,   '%H:%i')  AS saida,
           e.origem
      FROM escalas e
      JOIN funcionarios f ON f.id = e.funcionario_id
     WHERE f.empresa_id IN (?)
       ${apenasAtivos ? "AND f.ativo = 1" : ""}
       AND e.data BETWEEN ? AND ?
     ORDER BY e.data ASC, e.funcionario_id ASC, e.turno_ordem ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

async function fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos) {
  if (!empresaIds.length) return [];
  const [rows] = await pool.query(
    `
    WITH ev AS (
      SELECT
        a.funcionario_id,
        a.turno_ordem,
        DATE(a.data) AS data,
        UPPER(a.evento) AS evento,
        TIME_FORMAT(a.horario, '%H:%i') AS hhmm,
        CASE UPPER(TRIM(a.origem))
          WHEN 'AJUSTE' THEN 3
          WHEN 'IMPORTADO' THEN 2
          WHEN 'APONTADO' THEN 1
          ELSE 0
        END AS prio
      FROM apontamentos a
      JOIN funcionarios f ON f.id = a.funcionario_id
      WHERE f.empresa_id IN (?)
        ${apenasAtivos ? "AND f.ativo = 1" : ""}
        AND a.data BETWEEN ? AND ?
        AND a.status_tratamento = 'VALIDA'
    ),
    ent AS (
      SELECT data, funcionario_id, turno_ordem,
             MIN(hhmm) AS entrada,
             MAX(prio) AS prio_ent
      FROM ev
      WHERE evento='ENTRADA'
      GROUP BY data, funcionario_id, turno_ordem
    ),
    sai AS (
      SELECT data, funcionario_id, turno_ordem,
             MAX(hhmm) AS saida,
             MAX(prio) AS prio_sai
      FROM ev
      WHERE evento='SAIDA'
      GROUP BY data, funcionario_id, turno_ordem
    )
    SELECT
      e.data,
      e.funcionario_id,
      e.turno_ordem,
      e.entrada,
      s.saida,
      CASE
        WHEN COALESCE(s.prio_sai,0) >= COALESCE(e.prio_ent,0) THEN
          CASE s.prio_sai WHEN 3 THEN 'AJUSTE' WHEN 2 THEN 'IMPORTADO' WHEN 1 THEN 'APONTADO' ELSE 'APONTADO' END
        ELSE
          CASE e.prio_ent WHEN 3 THEN 'AJUSTE' WHEN 2 THEN 'IMPORTADO' WHEN 1 THEN 'APONTADO' ELSE 'APONTADO' END
      END AS origem
    FROM ent e
    LEFT JOIN sai s
      ON s.data=e.data AND s.funcionario_id=e.funcionario_id AND s.turno_ordem=e.turno_ordem
    
    UNION ALL
    
    SELECT
      s.data,
      s.funcionario_id,
      s.turno_ordem,
      e.entrada,
      s.saida,
      CASE
        WHEN COALESCE(s.prio_sai,0) >= COALESCE(e.prio_ent,0) THEN
          CASE s.prio_sai WHEN 3 THEN 'AJUSTE' WHEN 2 THEN 'IMPORTADO' WHEN 1 THEN 'APONTADO' ELSE 'APONTADO' END
        ELSE
          CASE e.prio_ent WHEN 3 THEN 'AJUSTE' WHEN 2 THEN 'IMPORTADO' WHEN 1 THEN 'APONTADO' ELSE 'APONTADO' END
      END AS origem
    FROM sai s
    LEFT JOIN ent e
      ON e.data=s.data AND e.funcionario_id=s.funcionario_id AND e.turno_ordem=s.turno_ordem
    WHERE e.funcionario_id IS NULL
    
    ORDER BY data ASC, funcionario_id ASC, turno_ordem ASC
    `,
    [empresaIds, from, to]
  );
  return rows;
}

// Nova função para calcular métricas do dashboard
async function calcularMetricasDashboard(funcionarios, escalas, apontamentos, from, to) {
  const metricas = {
    totais: {
      funcionarios: funcionarios.length,
      presentes: 0,
      ausentes: 0,
      atrasos: 0,
      escalas: escalas.length
    },
    diario: {},
    grafico: {
      dias: [],
      presentes: [],
      ausentes: [],
      atrasos: []
    }
  };

  // Gerar array de datas do período
  const datas = [];
  const dataInicio = new Date(from);
  const dataFim = new Date(to);
  for (let d = new Date(dataInicio); d <= dataFim; d.setDate(d.getDate() + 1)) {
    const dataStr = toISO(d);
    datas.push(dataStr);
    metricas.diario[dataStr] = { presentes: 0, ausentes: 0, atrasos: 0, escalados: 0 };
  }

  metricas.grafico.dias = datas.map(d => d.split('-').reverse().join('/'));

  // Calcular escalados por dia
  escalas.forEach(escala => {
    if (metricas.diario[escala.data]) {
      metricas.diario[escala.data].escalados++;
    }
  });

  // Calcular presentes, ausentes e atrasos
  const funcionariosComPresenca = new Set();
  const funcionariosComAtraso = new Set();

  apontamentos.forEach(ap => {
    if (metricas.diario[ap.data]) {
      // Considera presente se tem pelo menos uma entrada
      if (ap.entrada) {
        metricas.diario[ap.data].presentes++;
        funcionariosComPresenca.add(`${ap.funcionario_id}_${ap.data}`);
        
        // Verificar atraso comparando com a escala
        const escalaCorrespondente = escalas.find(e => 
          e.funcionario_id === ap.funcionario_id && 
          e.data === ap.data && 
          e.turno_ordem === ap.turno_ordem
        );
        
        if (escalaCorrespondente && escalaCorrespondente.entrada) {
          const [entradaH, entradaM] = ap.entrada.split(':').map(Number);
          const [escalaH, escalaM] = escalaCorrespondente.entrada.split(':').map(Number);
          
          const minutosApontamento = entradaH * 60 + entradaM;
          const minutosEscala = escalaH * 60 + escalaM;
          
          // Considera atraso se chegou mais de 5 minutos após o horário da escala
          if (minutosApontamento > minutosEscala + 5) {
            metricas.diario[ap.data].atrasos++;
            funcionariosComAtraso.add(`${ap.funcionario_id}_${ap.data}`);
          }
        }
      }
    }
  });

  // Calcular ausentes (escalados mas sem apontamento de entrada)
  escalas.forEach(escala => {
    const chave = `${escala.funcionario_id}_${escala.data}`;
    if (!funcionariosComPresenca.has(chave) && metricas.diario[escala.data]) {
      metricas.diario[escala.data].ausentes++;
    }
  });

  // Consolidar totais e dados do gráfico
  let totaisPeriodo = { presentes: 0, ausentes: 0, atrasos: 0 };
  
  datas.forEach(dataStr => {
    const dia = metricas.diario[dataStr];
    totaisPeriodo.presentes += dia.presentes;
    totaisPeriodo.ausentes += dia.ausentes;
    totaisPeriodo.atrasos += dia.atrasos;
    
    metricas.grafico.presentes.push(dia.presentes);
    metricas.grafico.ausentes.push(dia.ausentes);
    metricas.grafico.atrasos.push(dia.atrasos);
  });

  metricas.totais.presentes = totaisPeriodo.presentes;
  metricas.totais.ausentes = totaisPeriodo.ausentes;
  metricas.totais.atrasos = totaisPeriodo.atrasos;

  return metricas;
}

router.get("/dashboard/adm", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ 
      funcionarios: [], 
      escalas: [], 
      apontamentos: [], 
      metricas: null,
      period: null 
    });
    
    const apenasAtivos = String(req.query.ativos || "1") === "1";
    const data = (req.query.data || "").trim();
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    
    if (data) { 
      from = data; 
      to = data; 
    }
    if (!from || !to) { 
      ({ from, to } = weekRange()); 
    }

    const [funcionarios, escalas, apontamentos] = await Promise.all([
      fetchFuncionarios(empresaIds, apenasAtivos),
      fetchEscalas(empresaIds, from, to, apenasAtivos),
      fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos),
    ]);

    const metricas = await calcularMetricasDashboard(funcionarios, escalas, apontamentos, from, to);

    return res.json({ 
      funcionarios, 
      escalas, 
      apontamentos, 
      metricas,
      period: { from, to } 
    });
  } catch (e) {
    console.error("GET /api/dashboard/adm error:", e);
    return res.status(500).json({ ok: false, error: "Falha ao montar dashboard." });
  }
});

// Mantendo as outras rotas existentes...
router.get("/funcionarios", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const funcionarios = await fetchFuncionarios(empresaIds, apenasAtivos);
    res.json({ funcionarios });
  } catch (e) {
    console.error("GET /api/funcionarios error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar funcionários." });
  }
});

router.get("/escalas", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ escalas: [] });
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());
    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const escalas = await fetchEscalas(empresaIds, from, to, apenasAtivos);
    res.json({ escalas, period: { from, to } });
  } catch (e) {
    console.error("GET /api/escalas error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar escalas." });
  }
});

router.get("/apontamentos", mustBeAuthed, async (req, res) => {
  try {
    const empresaIds = await getEmpresaIdsByUser(req.userId);
    if (!empresaIds.length) return res.json({ apontamentos: [] });
    let from = (req.query.from || "").trim();
    let to   = (req.query.to   || "").trim();
    if (!from || !to) ({ from, to } = weekRange());
    const apenasAtivos = String(req.query.ativos || "0") === "1";
    const apontamentos = await fetchApontamentosConsolidados(empresaIds, from, to, apenasAtivos);
    res.json({ apontamentos, period: { from, to } });
  } catch (e) {
    console.error("GET /api/apontamentos error:", e);
    res.status(500).json({ ok: false, error: "Falha ao listar apontamentos." });
  }
});

export default router;