// agent/src/authMiddleware.js
// ─── IPEM Auth Middleware ──────────────────────────────────────────────────────

const { verifyToken, isSessionValid } = require('./auth');
const { dbGet } = require('./database');
const { hasRole, hasAnyRole } = require('./rbac');

/**
 * requireAuth — Validates JWT from Authorization header or cookie.
 * Attaches req.user = { userId, email } on success.
 * Returns 401 if invalid/missing.
 */
async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
    }

    // Validate token is still in DB (handles logout/revocation)
    const valid = await isSessionValid(token);
    if (!valid) {
      return res.status(401).json({ error: 'Session expired or revoked', code: 'INVALID_SESSION' });
    }

    // Set SameSite=None cookie for cross-origin preview asset requests if token is passed in query
    if (req.query?.token === token) {
      res.cookie('ipem_token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
      });
    }

    const user = await dbGet(
      'SELECT id, email, role, status FROM users WHERE id = ?',
      [payload.userId]
    );
    if (!user) {
      return res.status(401).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }
    if (user.status === 'banned' || user.status === 'disabled') {
      return res.status(403).json({
        error: user.status === 'banned' ? 'Account is banned' : 'Account is disabled',
        code: user.status === 'banned' ? 'ACCOUNT_BANNED' : 'ACCOUNT_DISABLED'
      });
    }

    req.user = {
      userId: user.id,
      email: user.email,
      role: user.role || 'user',
      status: user.status || 'active'
    };
    req.token = token;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * optionalAuth — Like requireAuth but doesn't reject unauthenticated requests.
 * Useful for endpoints that behave differently for authenticated vs anonymous users.
 */
async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      const payload = verifyToken(token);
      if (payload) {
        const valid = await isSessionValid(token);
        if (valid) {
          const user = await dbGet(
            'SELECT id, email, role, status FROM users WHERE id = ?',
            [payload.userId]
          );
          if (user && user.status !== 'banned' && user.status !== 'disabled') {
            req.user = {
              userId: user.id,
              email: user.email,
              role: user.role || 'user',
              status: user.status || 'active'
            };
            req.token = token;
          }
        }
      }
    }
    next();
  } catch {
    next();
  }
}

/**
 * scopeByUser — Rewrites query/body parameters so data access is scoped to
 * the authenticated user. Attaches req.userId for convenience.
 */
function scopeByUser(req, res, next) {
  if (!req.user) return next();
  req.userId = req.user.userId;

  // Inject userId into body for POST/PUT so handlers don't have to
  if (req.body && typeof req.body === 'object') {
    req.body._userId = req.user.userId;
  }
  next();
}

function requireActiveStatus(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  }
  if (req.user.status === 'active') return next();

  const code = req.user.status === 'suspended'
    ? 'ACCOUNT_SUSPENDED'
    : req.user.status === 'banned'
    ? 'ACCOUNT_BANNED'
    : 'ACCOUNT_DISABLED';

  return res.status(403).json({
    error: 'Account is not active',
    message: req.user.status === 'suspended'
      ? 'Account is suspended. Login is allowed, but API actions are blocked.'
      : 'Account is blocked.',
    code,
    status: req.user.status
  });
}

function requireRole(requiredRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    }
    if (req.user.status !== 'active') {
      return requireActiveStatus(req, res, next);
    }
    if (!hasRole(req.user.role, requiredRole)) {
      return res.status(403).json({
        error: 'Insufficient role',
        code: 'INSUFFICIENT_ROLE',
        required_role: requiredRole
      });
    }
    return next();
  };
}

function requireAnyRole(requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    }
    if (req.user.status !== 'active') {
      return requireActiveStatus(req, res, next);
    }
    if (!Array.isArray(requiredRoles) || !hasAnyRole(req.user.role, requiredRoles)) {
      return res.status(403).json({
        error: 'Insufficient role',
        code: 'INSUFFICIENT_ROLE',
        required_roles: requiredRoles
      });
    }
    return next();
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 2. Cookie: ipem_token=<token>  (HTTP-only, set by backend)
  if (req.cookies?.ipem_token) {
    return req.cookies.ipem_token;
  }
  // 3. Query Parameter: ?token=<token>
  if (req.query?.token) {
    return req.query.token;
  }
  return null;
}

module.exports = {
  requireAuth,
  optionalAuth,
  scopeByUser,
  requireActiveStatus,
  requireRole,
  requireAnyRole
};
