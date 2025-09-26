router.post("/login", async (req, res) => {
  try {
    let { email, senha } = req.body || {};
    if (!email || !senha) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // normaliza entrada
    email = String(email).trim().toLowerCase();
    senha = String(senha);

    console.log('🔐 LOGIN attempt for:', email);

    const [rows] = await pool.query(
      `SELECT id, nome, email, senha, ativo
         FROM usuarios
        WHERE email = ?
        LIMIT 1`,
      [email]
    );

    const user = rows?.[0];
    if (!user) {
      console.log('❌ User not found');
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    if (user.ativo !== true && user.ativo !== 1) {
      console.log('❌ User inactive');
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    console.log('✅ User found:', user.email);
    console.log('🔐 Stored password prefix:', user.senha.substring(0, 30));

    // VERIFICAÇÃO SIMPLIFICADA - sempre tenta bcrypt primeiro
    let passwordOK = false;
    
    try {
      // Tenta comparar com bcrypt (para senhas hasheadas)
      passwordOK = await bcrypt.compare(senha, user.senha);
      console.log('🔐 bcrypt.compare result:', passwordOK);
    } catch (bcryptError) {
      console.log('🔐 bcrypt.compare failed, trying plain text');
      // Fallback para texto plano (apenas durante transição)
      passwordOK = senha === user.senha;
    }

    if (!passwordOK) {
      console.log('❌ Password mismatch');
      console.log('🔐 Input password:', senha);
      console.log('🔐 Stored password length:', user.senha.length);
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    console.log('✅ Login successful for:', user.email);

    const token = jwt.sign(
      { sub: user.id, email: user.email, nome: user.nome },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES || "1d" }
    );

    res.cookie("token", token, cookieOptions());
    return res.json({
      ok: true,
      user: { id: user.id, email: user.email, nome: user.nome },
    });
  } catch (e) {
    console.error("LOGIN_ERROR", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});
