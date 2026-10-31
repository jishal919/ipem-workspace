const { auditStorage } = require('./auditLogger');

/**
 * Express middleware to automatically capture metadata (IP address, user-agent)
 * and bind the request user information dynamically via lazy getters.
 */
function auditContextMiddleware(req, res, next) {
  // Capture client IP, respecting proxy headers if present
  const ipAddress = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.ip || req.socket.remoteAddress || null;

  const userAgent = req.headers['user-agent'] || null;

  // Run downstream handlers inside AsyncLocalStorage context.
  // Properties use lazy getters so they resolve dynamically even if
  // requireAuth middleware populates req.user later in the routing cycle.
  auditStorage.run({
    req,
    ip_address: ipAddress,
    user_agent: userAgent,
    get actor_user_id() { return req.user?.userId || null; },
    get actor_email() { return req.user?.email || null; },
    get actor_role() { return req.user?.role || null; }
  }, () => {
    next();
  });
}

module.exports = {
  auditContextMiddleware
};
