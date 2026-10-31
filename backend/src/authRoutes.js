// agent/src/authRoutes.js
// ─── IPEM Auth Routes ─────────────────────────────────────────────────────────
// Mount this in server.js:  app.use('/auth', require('./authRoutes'));

const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const router = express.Router();
const {
  signup, verifyOTP, resendOTP, login,
  handleGoogleCallback, revokeSession, getUserProfile
} = require('./auth');
const { requireAuth, requireActiveStatus } = require('./authMiddleware');
const { auditLog } = require('./auditLogger');
const { trackActivity } = require('./userActivity');
require('dotenv').config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

// ─── HELPER ───────────────────────────────────────────────────────────────────
function setCookieAndRespond(req, res, token, userData) {
  res.cookie('ipem_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days
  });

  try {
    const { getDeviceFingerprint, analyzeUserThreats } = require('./threatEngine');
    const ip = req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip || req.socket.remoteAddress || null;
    const fingerprint = getDeviceFingerprint(req);
    analyzeUserThreats(userData.id, ip, fingerprint, true).catch(err => {
      console.error('[THREAT ANALYSIS ERROR] Failed to analyze login threats:', err.message);
    });
  } catch (err) {
    console.error('[THREAT ANALYSIS ENGINE ERROR] Failed to load threatEngine:', err.message);
  }

  res.json({ ok: true, token, user: userData });
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    const result = await signup({ name, email, password });
    res.status(201).json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /auth/verify-otp ────────────────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    const result = await verifyOTP({ email, otp });
    setCookieAndRespond(req, res, result.token, {
      id: result.userId,
      name: result.name,
      email: result.email,
      role: result.role,
      status: result.status
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /auth/resend-otp ────────────────────────────────────────────────────
router.post('/resend-otp', async (req, res) => {
  try {
    const result = await resendOTP(req.body.email);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await login({ email, password });
    setCookieAndRespond(req, res, result.token, result.user);
  } catch (err) {
    const payload = { error: err.message };
    if (err.code === 'UNVERIFIED') payload.code = 'UNVERIFIED', payload.email = err.email;
    res.status(err.status || 500).json(payload);
  }
});

// ─── POST /auth/google ────────────────────────────────────────────────────────
// Accepts a Google ID token from the frontend (Sign In With Google button)
router.post('/google', async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ error: 'Google OAuth not configured' });
  }
  try {
    const { credential } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const { sub: googleId, email, name, picture: avatar } = ticket.getPayload();
    const result = await handleGoogleCallback({ googleId, email, name, avatar });
    setCookieAndRespond(req, res, result.token, result.user);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/profile', requireAuth, requireActiveStatus, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const trimmed = name.trim();
    if (trimmed.length < 2)  return res.status(400).json({ error: 'Name must be at least 2 characters' });
    if (trimmed.length > 60) return res.status(400).json({ error: 'Name must be under 60 characters' });

    const { dbRun, dbGet } = require('./database');
    await dbRun('UPDATE users SET name = ? WHERE id = ?', [trimmed, req.user.userId]);

    const updated = await dbGet(
      'SELECT id, name, email, created_at FROM users WHERE id = ?',
      [req.user.userId]
    );
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  try {
    await revokeSession(req.token);

    // Log logout (Phase 2)
    await auditLog({
      action: 'LOGOUT',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: req.user.userId
    });

    // Track activity (Phase 4)
    trackActivity({
      userId: req.user.userId,
      userEmail: req.user.email,
      activityType: 'LOGOUT',
      resourceType: 'user',
      resourceId: req.user.userId
    });

    res.clearCookie('ipem_token');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/account', requireAuth, requireActiveStatus, async (req, res) => {
  try {
    const { dbGet } = require('./database');
    const { deleteUserCompletely } = require('./userStorage');
    const userId = req.user.userId;
    const user = await dbGet('SELECT role FROM users WHERE id = ?', [userId]);
    if (user?.role === 'owner') {
      return res.status(403).json({
        error: 'Owner cannot delete their own account',
        code: 'OWNER_SELF_DELETE_PROTECTION'
      });
    }

    // Perform complete deletion (files + database rows)
    await deleteUserCompletely(userId);

    // Log account deletion (Phase 2)
    const { auditLog } = require('./auditLogger');
    await auditLog({
      action: 'ACCOUNT_DELETED',
      actorId: userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: userId
    });

    // Track activity (Phase 4)
    const { trackActivity } = require('./userActivity');
    trackActivity({
      userId,
      userEmail: req.user.email,
      activityType: 'ACCOUNT_DELETED',
      resourceType: 'user',
      resourceId: userId
    });

    res.clearCookie('ipem_token');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await getUserProfile(req.user.userId);
    res.json({ ok: true, user });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;