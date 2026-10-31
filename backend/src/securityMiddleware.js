const { dbGet } = require('./database');
const { getDeviceFingerprint } = require('./threatEngine');

/**
 * Global Security Middleware to block banned IPs and blocked devices.
 */
async function securityBanMiddleware(req, res, next) {
  // Resolve client IP (supporting reverse proxies)
  const ip = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || null;

  try {
    // 1. Check IP Ban status
    if (ip) {
      const ban = await dbGet(`
        SELECT * FROM banned_ips
        WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
        LIMIT 1
      `, [ip]);

      if (ban) {
        return res.status(403).json({
          error: 'Access denied: IP address is banned',
          code: 'IP_BANNED',
          reason: ban.reason || 'No reason specified',
          expires_at: ban.expires_at || 'Permanent'
        });
      }
    }

    // 2. Check Device Fingerprint status
    const fingerprint = getDeviceFingerprint(req);
    if (fingerprint) {
      const block = await dbGet(`
        SELECT * FROM blocked_devices
        WHERE device_fingerprint = ?
        LIMIT 1
      `, [fingerprint]);

      if (block) {
        return res.status(403).json({
          error: 'Access denied: Device is blocked',
          code: 'DEVICE_BLOCKED',
          reason: block.reason || 'No reason specified'
        });
      }
    }

    next();
  } catch (err) {
    console.error('[SECURITY MIDDLEWARE] Error checking ban status:', err.message);
    // Fail safe: allow request to proceed if database query fails, but log error
    next();
  }
}

module.exports = {
  securityBanMiddleware
};
