import jwt from "jsonwebtoken";

export function requireAuth(req, res, next) {
  try {
    const { token } = req.cookies || {};
    if (!token) return res.status(401).json({ ok: false, error: "unauthenticated" });

    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, nome: payload.nome };
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "invalid_token" });
  }
}
