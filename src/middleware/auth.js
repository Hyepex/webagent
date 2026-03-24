const jwt = require("jsonwebtoken");
const config = require("../config");
const User = require("../models/User");

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret);
    const user = await User.findById(payload.userId);
    if (!user) return res.status(401).json({ error: "User not found" });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function generateToken(userId) {
  return jwt.sign({ userId }, config.auth.jwtSecret, { expiresIn: "7d" });
}

module.exports = { requireAuth, generateToken };
