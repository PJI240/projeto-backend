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

module.exports = router;
