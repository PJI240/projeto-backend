// /backend/src/routes/health.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: rows[0].ok === 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ROTA: POST /api/auth/register
// body: { nome, email, senha }
router.post("/register", async (req, res) => {
  try {
    let { nome, email, senha } = req.body || {};
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    nome = String(nome).trim();
    email = String(email).trim().toLowerCase();
    senha = String(senha);

    // validações simples
    if (senha.length < 6) {
      return res.status(400).json({ ok: false, error: "password_too_short" });
    }

    // verifica se já existe
    const [exists] = await pool.query(
      "SELECT id FROM usuarios WHERE LOWER(email) = ? LIMIT 1",
      [email]
    );
    if (exists?.length) {
      return res.status(409).json({ ok: false, error: "email_already_in_use" });
    }

    // hash da senha
    const hash = await bcrypt.hash(senha, 10);

    // tenta inserir na coluna senha_hash, caso não exista, tenta inserir em senha (fallback)
    try {
      await pool.query(
        "INSERT INTO usuarios (nome, email, senha_hash, ativo) VALUES (?, ?, ?, 1)",
        [nome, email, hash]
      );
    } catch (insertErr) {
      // se coluna senha_hash não existe, tenta coluna senha (compatibilidade)
      if (String(insertErr.message || "").toLowerCase().includes("unknown column")) {
        await pool.query(
          "INSERT INTO usuarios (nome, email, senha, ativo) VALUES (?, ?, ?, 1)",
          [nome, email, hash]
        );
      } else {
        throw insertErr;
      }
    }

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error("REGISTER_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

module.exports = router;
