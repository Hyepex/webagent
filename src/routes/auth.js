const express = require("express");
const bcrypt = require("bcryptjs");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const config = require("../config");
const { requireAuth, generateToken } = require("../middleware/auth");
const { sanitizeInput } = require("../middleware/taskLimits");

const router = express.Router();

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "Username, email, and password are required" });
    }

    const cleanUsername = sanitizeInput(username);
    const cleanEmail = sanitizeInput(email);

    if (!cleanUsername || cleanUsername.length > 50) {
      return res.status(400).json({ error: "Username must be 1-50 characters" });
    }
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 6-128 characters" });
    }

    const existing = await User.findOne({ email: cleanEmail.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const user = await User.create({ username: cleanUsername, email: cleanEmail.toLowerCase(), password_hash });
    const token = generateToken(user._id);

    res.status(201).json({ token, user: user.toProfile() });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const cleanEmail = sanitizeInput(email);
    if (!cleanEmail) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const user = await User.findOne({ email: cleanEmail.toLowerCase() });
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = generateToken(user._id);
    res.json({ token, user: user.toProfile() });
  } catch (err) {
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/auth/google
router.post("/google", async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Google credential is required" });
    }

    const clientId = config.auth.googleClientId;
    if (!clientId) {
      return res.status(500).json({ error: "Google OAuth not configured" });
    }

    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();

    let user = await User.findOne({ email: payload.email.toLowerCase() });
    if (!user) {
      user = await User.create({
        username: payload.name || payload.email.split("@")[0],
        email: payload.email.toLowerCase(),
        google_id: payload.sub,
        profile_picture: payload.picture || null,
      });
    } else {
      // Link Google ID and update picture if not already set
      if (!user.google_id) user.google_id = payload.sub;
      if (payload.picture) user.profile_picture = payload.picture;
      await user.save();
    }

    const token = generateToken(user._id);
    res.json({ token, user: user.toProfile() });
  } catch (err) {
    res.status(401).json({ error: "Google authentication failed" });
  }
});

// GET /api/auth/me
router.get("/me", requireAuth, (req, res) => {
  req.user.checkDailyReset();
  res.json({ user: req.user.toProfile() });
});

module.exports = router;
