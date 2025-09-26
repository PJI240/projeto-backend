// Versão alternativa - debug completo
router.post("/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    
    if (!email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    console.log('🔐 LOGIN DEBUG ==========');
    console.log('Email:', email);
    console.log('Password length:', senha.length);

    const [users] = await pool.query(
      `SELECT * FROM usuarios WHERE email = ?`,
      [email.toLowerCase()]
    );

    if (users.length === 0) {
      console.log('❌ No user found');
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const user = users[0];
    console.log('✅ User found:', user.id, user.email);
    console.log('🔐 Stored hash:', user.senha.substring(0, 50) + '...');

    // Tenta bcrypt compare
    const isMatch = await bcrypt.compare(senha, user.senha);
    console.log('🔐 Password match:', isMatch);

    if (!isMatch) {
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    // Sucesso
    const token = jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.cookie("token", token, cookieOptions());
    res.json({ ok: true, user: { id: user.id, email: user.email, nome: user.nome } });

  } catch (error) {
    console.error('💥 LOGIN_ERROR:', error);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
