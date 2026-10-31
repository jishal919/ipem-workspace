// agent/src/auth.js
// ─── IPEM Authentication Module ───────────────────────────────────────────────
// Handles: JWT tokens, bcrypt passwords, OTP via email, Google OAuth

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { dbRun, dbAll, dbGet } = require('./database');
const { auditLog } = require('./auditLogger');
const { trackActivity } = require('./userActivity');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Set it in the backend environment before starting IPEM.');
}

const JWT_EXPIRY = '7d';
const OTP_EXPIRY_MINUTES = 10;
const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// ─── EMAIL TRANSPORT ──────────────────────────────────────────────────────────
let transporter = null;

function getEmailTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[AUTH] SMTP credentials not configured — OTP emails will not send.');
    return null;
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS  // Gmail App Password (not your actual password)
    }
  });
  return transporter;
}

// ─── OTP HELPERS ──────────────────────────────────────────────────────────────
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

async function sendOTPEmail(email, otp, purpose = 'verification') {
  const transport = getEmailTransporter();
  if (!transport) {
    console.log(`[AUTH DEV] OTP for ${email}: ${otp}`);  // Dev fallback
    return { dev: true, otp };
  }

  const subject = purpose === 'reset'
    ? 'IPEM — Password Reset OTP'
    : 'IPEM — Email Verification OTP';

  const html = `
    <div style="font-family:'Courier New',monospace;background:#0a0a0f;color:#e8e8f0;padding:40px;max-width:480px;margin:0 auto;border-radius:12px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:32px;">
        <div style="width:40px;height:40px;background:linear-gradient(135deg,#7c6af7,#00d4ff);border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;font-size:14px;">IP</div>
        <span style="font-family:sans-serif;font-size:18px;font-weight:700;color:#e8e8f0;">IPEM</span>
      </div>
      <p style="color:#9090a8;font-size:13px;margin-bottom:8px;">Your one-time code:</p>
      <div style="font-size:42px;letter-spacing:12px;color:#a394ff;font-weight:700;margin:16px 0;padding:20px;background:#0f0f18;border:1px solid rgba(124,106,247,0.3);border-radius:10px;text-align:center;">
        ${otp}
      </div>
      <p style="color:#5a5a72;font-size:11px;margin-top:24px;">Valid for ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.</p>
    </div>
  `;

  await transport.sendMail({
    from: `"IPEM" <${process.env.SMTP_USER}>`,
    to: email,
    subject,
    html
  });

  return { sent: true };
}

// ─── TOKEN MANAGEMENT ─────────────────────────────────────────────────────────
function issueToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── RATE LIMITING (DB-backed) ────────────────────────────────────────────────
async function checkRateLimit(identifier) {
  const record = await dbGet(
    'SELECT attempts, locked_until FROM rate_limits WHERE identifier = ?',
    [identifier]
  );

  if (!record) return { allowed: true };

  const now = new Date();
  if (record.locked_until && new Date(record.locked_until) > now) {
    const remaining = Math.ceil((new Date(record.locked_until) - now) / 60000);
    return { allowed: false, remaining };
  }

  if (record.attempts >= MAX_LOGIN_ATTEMPTS) {
    const lockedUntil = new Date(now.getTime() + LOCKOUT_MINUTES * 60000);
    await dbRun(
      'UPDATE rate_limits SET locked_until = ? WHERE identifier = ?',
      [lockedUntil.toISOString(), identifier]
    );
    return { allowed: false, remaining: LOCKOUT_MINUTES };
  }

  return { allowed: true };
}

async function incrementRateLimit(identifier) {
  await dbRun(`
    INSERT INTO rate_limits (identifier, attempts, last_attempt)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(identifier) DO UPDATE SET
      attempts = CASE WHEN locked_until IS NULL OR locked_until < CURRENT_TIMESTAMP
                      THEN attempts + 1 ELSE attempts END,
      last_attempt = CURRENT_TIMESTAMP
  `, [identifier]);
}

async function resetRateLimit(identifier) {
  await dbRun(
    'DELETE FROM rate_limits WHERE identifier = ?',
    [identifier]
  );
}

// ─── SIGNUP ───────────────────────────────────────────────────────────────────
async function signup({ name, email, password }) {
  // Validate
  if (!name?.trim() || !email?.trim() || !password) {
    throw Object.assign(new Error('Name, email, and password are required'), { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Invalid email format'), { status: 400 });
  }
  if (password.length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
  }

  const existing = await dbGet('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
  if (existing) {
    throw Object.assign(new Error('Email already registered'), { status: 409 });
  }

  const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const otp = generateOTP();
  const otpHash = await bcrypt.hash(otp, 10);
  const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000).toISOString();

  const result = await dbRun(`
    INSERT INTO users (name, email, password_hash, otp_hash, otp_expiry, verified, created_at)
    VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)
  `, [name.trim(), email.toLowerCase(), hashedPassword, otpHash, otpExpiry]);

  await sendOTPEmail(email.toLowerCase(), otp, 'verification');

  // Log account creation (Phase 2)
  await auditLog({
    action: 'ACCOUNT_CREATED',
    actorId: result.lastID,
    actorEmail: email.toLowerCase(),
    targetType: 'user',
    targetId: result.lastID,
    metadata: { name: name.trim() }
  });

  // Track activity (Phase 4)
  trackActivity({
    userId: result.lastID,
    userEmail: email.toLowerCase(),
    activityType: 'ACCOUNT_CREATED',
    resourceType: 'user',
    resourceId: result.lastID
  });

  return { userId: result.lastID, email: email.toLowerCase(), message: 'OTP sent to email' };
}

// ─── VERIFY OTP ───────────────────────────────────────────────────────────────
async function verifyOTP({ email, otp }) {
  const normalEmail = email.toLowerCase();
  const user = await dbGet(
    'SELECT id, name, otp_hash, otp_expiry, verified, role, status FROM users WHERE email = ?',
    [normalEmail]
  );

  if (!user) {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorEmail: normalEmail,
      targetType: 'user',
      success: false,
      reason: 'User not found during OTP verification'
    });
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  if (user.status === 'banned' || user.status === 'disabled') {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: normalEmail,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: `OTP verification blocked: Account is ${user.status}`
    });
    throw Object.assign(
      new Error(user.status === 'banned' ? 'Account is banned' : 'Account is disabled'),
      { status: 403, code: user.status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_DISABLED' }
    );
  }
  if (user.verified) throw Object.assign(new Error('Email already verified'), { status: 409 });

  if (!user.otp_hash || !user.otp_expiry) {
    throw Object.assign(new Error('No OTP pending'), { status: 400 });
  }
  if (new Date(user.otp_expiry) < new Date()) {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: normalEmail,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: 'OTP expired'
    });
    throw Object.assign(new Error('OTP expired'), { status: 400 });
  }

  const valid = await bcrypt.compare(otp.toString(), user.otp_hash);
  if (!valid) {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: normalEmail,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: 'Invalid OTP'
    });
    throw Object.assign(new Error('Invalid OTP'), { status: 400 });
  }

  await dbRun(
    'UPDATE users SET verified = 1, otp_hash = NULL, otp_expiry = NULL WHERE id = ?',
    [user.id]
  );

  const token = issueToken(user.id, normalEmail);
  await storeSession(user.id, token);

  // Log successful login via OTP (Phase 2)
  await auditLog({
    action: 'LOGIN_SUCCESS',
    actorId: user.id,
    actorEmail: normalEmail,
    actorRole: user.role || 'user',
    targetType: 'user',
    targetId: user.id,
    metadata: { method: 'otp' }
  });

  // Track activity (Phase 4)
  trackActivity({
    userId: user.id,
    userEmail: normalEmail,
    activityType: 'LOGIN',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { method: 'otp' }
  });

  return {
    token,
    userId: user.id,
    name: user.name,
    email: normalEmail,
    role: user.role || 'user',
    status: user.status || 'active'
  };
}

// ─── RESEND OTP ───────────────────────────────────────────────────────────────
async function resendOTP(email) {
  const limit = await checkRateLimit(`otp:${email}`);
  if (!limit.allowed) {
    throw Object.assign(
      new Error(`Too many attempts. Try again in ${limit.remaining} minutes.`),
      { status: 429 }
    );
  }
  await incrementRateLimit(`otp:${email}`);

  const user = await dbGet(
    'SELECT id, verified FROM users WHERE email = ?',
    [email.toLowerCase()]
  );
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.verified) throw Object.assign(new Error('Email already verified'), { status: 409 });

  const otp = generateOTP();
  const otpHash = await bcrypt.hash(otp, 10);
  const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000).toISOString();

  await dbRun(
    'UPDATE users SET otp_hash = ?, otp_expiry = ? WHERE id = ?',
    [otpHash, otpExpiry, user.id]
  );

  await sendOTPEmail(email.toLowerCase(), otp, 'verification');
  return { message: 'OTP resent' };
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
async function login({ email, password }) {
  const normalEmail = email?.toLowerCase();

  const limit = await checkRateLimit(`login:${normalEmail}`);
  if (!limit.allowed) {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorEmail: normalEmail,
      targetType: 'user',
      success: false,
      reason: `Rate limit lockout (locked for ${limit.remaining} minutes)`
    });
    throw Object.assign(
      new Error(`Too many failed attempts. Try again in ${limit.remaining} minutes.`),
      { status: 429 }
    );
  }

  const user = await dbGet(
    'SELECT id, name, email, password_hash, verified, role, status FROM users WHERE email = ?',
    [normalEmail]
  );

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    await incrementRateLimit(`login:${normalEmail}`);
    await auditLog({
      action: 'LOGIN_FAILED',
      actorEmail: normalEmail,
      targetType: 'user',
      success: false,
      reason: 'Invalid email or password'
    });
    throw Object.assign(new Error('Invalid email or password'), { status: 401 });
  }

  if (!user.verified) {
    // Resend OTP silently
    const otp = generateOTP();
    const otpHash = await bcrypt.hash(otp, 10);
    const otpExpiry = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000).toISOString();
    await dbRun(
      'UPDATE users SET otp_hash = ?, otp_expiry = ? WHERE id = ?',
      [otpHash, otpExpiry, user.id]
    );
    await sendOTPEmail(normalEmail, otp);
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: normalEmail,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: 'Email not verified. Silent OTP resent.'
    });
    throw Object.assign(
      new Error('Email not verified. New OTP sent.'),
      { status: 403, code: 'UNVERIFIED', email: normalEmail }
    );
  }

  if (user.status === 'banned' || user.status === 'disabled') {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: normalEmail,
      actorRole: user.role,
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: `Login blocked: Account is ${user.status}`
    });
    throw Object.assign(
      new Error(user.status === 'banned' ? 'Account is banned' : 'Account is disabled'),
      { status: 403, code: user.status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_DISABLED' }
    );
  }

  await resetRateLimit(`login:${normalEmail}`);

  const token = issueToken(user.id, user.email);
  await storeSession(user.id, token);

  await dbRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  // Log successful login (Phase 2)
  await auditLog({
    action: 'LOGIN_SUCCESS',
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role || 'user',
    targetType: 'user',
    targetId: user.id,
    metadata: { method: 'password' }
  });

  // Track activity (Phase 4)
  trackActivity({
    userId: user.id,
    userEmail: user.email,
    activityType: 'LOGIN',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { method: 'password' }
  });

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role || 'user',
      status: user.status || 'active'
    }
  };
}

// ─── GOOGLE OAUTH ─────────────────────────────────────────────────────────────
async function handleGoogleCallback({ googleId, email, name, avatar }) {
  let user = await dbGet(
    'SELECT id, name, email, role, status FROM users WHERE google_id = ? OR email = ?',
    [googleId, email.toLowerCase()]
  );

  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    const result = await dbRun(`
      INSERT INTO users (name, email, google_id, verified, created_at)
      VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
    `, [name, email.toLowerCase(), googleId]);
    user = { id: result.lastID, name, email: email.toLowerCase(), role: 'user', status: 'active' };

    // Log account creation (Phase 2)
    await auditLog({
      action: 'ACCOUNT_CREATED',
      actorId: user.id,
      actorEmail: user.email,
      actorRole: 'user',
      targetType: 'user',
      targetId: user.id,
      metadata: { oauth: 'google', name }
    });

    // Track activity (Phase 4)
    trackActivity({
      userId: user.id,
      userEmail: user.email,
      activityType: 'ACCOUNT_CREATED',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { oauth: 'google' }
    });
  } else if (!user.google_id) {
    // Link Google ID to existing email account
    await dbRun('UPDATE users SET google_id = ?, verified = 1 WHERE id = ?', [googleId, user.id]);
  }

  if (user.status === 'banned' || user.status === 'disabled') {
    await auditLog({
      action: 'LOGIN_FAILED',
      actorId: user.id,
      actorEmail: user.email,
      actorRole: user.role || 'user',
      targetType: 'user',
      targetId: user.id,
      success: false,
      reason: `Google login blocked: Account is ${user.status}`,
      metadata: { oauth: 'google' }
    });
    throw Object.assign(
      new Error(user.status === 'banned' ? 'Account is banned' : 'Account is disabled'),
      { status: 403, code: user.status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_DISABLED' }
    );
  }

  const token = issueToken(user.id, user.email);
  await storeSession(user.id, token);
  await dbRun('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

  // Log successful login (Phase 2)
  await auditLog({
    action: 'LOGIN_SUCCESS',
    actorId: user.id,
    actorEmail: user.email,
    actorRole: user.role || 'user',
    targetType: 'user',
    targetId: user.id,
    metadata: { oauth: 'google' }
  });

  // Track activity (Phase 4)
  trackActivity({
    userId: user.id,
    userEmail: user.email,
    activityType: 'LOGIN',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { oauth: 'google' }
  });

  return {
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role || 'user',
      status: user.status || 'active'
    }
  };
}

// ─── SESSION STORAGE ──────────────────────────────────────────────────────────
async function storeSession(userId, token) {
  const payload = verifyToken(token);
  const expiresAt = new Date(payload.exp * 1000).toISOString();

  await dbRun(`
    INSERT INTO user_sessions (user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `, [userId, crypto.createHash('sha256').update(token).digest('hex'), expiresAt]);

  // Clean up old expired sessions for this user
  await dbRun(
    'DELETE FROM user_sessions WHERE user_id = ? AND expires_at < CURRENT_TIMESTAMP',
    [userId]
  );
}

async function revokeSession(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await dbRun('DELETE FROM user_sessions WHERE token_hash = ?', [tokenHash]);
}

async function isSessionValid(token) {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = await dbGet(
    'SELECT id FROM user_sessions WHERE token_hash = ? AND expires_at > CURRENT_TIMESTAMP',
    [tokenHash]
  );
  return !!session;
}

// ─── USER PROFILE ─────────────────────────────────────────────────────────────
async function getUserProfile(userId) {
  const user = await dbGet(
    'SELECT id, name, email, verified, role, status, created_at, last_login FROM users WHERE id = ?',
    [userId]
  );
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  return user;
}

module.exports = {
  signup,
  verifyOTP,
  resendOTP,
  login,
  handleGoogleCallback,
  verifyToken,
  issueToken,
  revokeSession,
  isSessionValid,
  getUserProfile,
  sendOTPEmail
};
