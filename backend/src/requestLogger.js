const { db, dbRun, dbGet } = require('./database');
const { performance } = require('perf_hooks');

// In-memory queue for requests metrics
let requestLogQueue = [];
const BATCH_SIZE_LIMIT = 100;
const FLUSH_INTERVAL_MS = 3000;

// Abuse detection in-memory sliding windows (cleared dynamically)
const ipRequestWindow = new Map(); // IP -> Array of timestamps
const ipAuthFailures = new Map();  // IP -> Array of timestamps
const ip404Failures = new Map();   // IP -> Array of timestamps
const ipGeneralFailures = new Map(); // IP -> Array of timestamps

/**
 * Global Request Logger Middleware
 */
function requestLoggerMiddleware(req, res, next) {
  const startTime = performance.now();
  const requestSize = parseInt(req.headers['content-length'] || '0', 10) || JSON.stringify(req.body || {}).length;

  // Overwrite response write and end to calculate response body size
  let responseSize = 0;
  const oldWrite = res.write;
  const oldEnd = res.end;

  res.write = function (chunk, ...args) {
    if (chunk) {
      responseSize += chunk.length || 0;
    }
    return oldWrite.apply(res, [chunk, ...args]);
  };

  res.end = function (chunk, ...args) {
    if (chunk) {
      responseSize += chunk.length || 0;
    }
    return oldEnd.apply(res, [chunk, ...args]);
  };

  res.on('finish', () => {
    const durationMs = performance.now() - startTime;
    const statusCode = res.statusCode;
    const success = statusCode >= 200 && statusCode < 400 ? 1 : 0;
    const errorMessage = res.statusMessage || null;

    // Resolve client IP (supporting reverse proxies)
    const ipAddress = req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip || req.socket.remoteAddress || null;

    const userAgent = req.headers['user-agent'] || null;

    // Resolve user context dynamically (populated by requireAuth middleware)
    const userId = req.user?.userId || null;
    const userEmail = req.user?.email || null;
    const userRole = req.user?.role || null;

    const route = req.route ? req.route.path : req.path;

    const logItem = {
      userId,
      userEmail,
      userRole,
      ipAddress,
      userAgent,
      method: req.method,
      route,
      statusCode,
      durationMs,
      requestSize,
      responseSize,
      success,
      errorMessage,
      metadataJson: JSON.stringify({
        query: req.query || {},
        params: req.params || {}
      }),
      timestamp: new Date().toISOString()
    };

    // Push to the buffer queue
    requestLogQueue.push(logItem);

    // If buffer grows too large, trigger an immediate asynchronous flush
    if (requestLogQueue.length >= BATCH_SIZE_LIMIT) {
      flushRequestLogs().catch(err => console.error('[FLUSH ERROR]:', err));
    }

    // Run abuse detection logic asynchronously
    runAbuseDetection(logItem, req);
  });

  next();
}

/**
 * Flush all buffered request logs to the SQLite database using a single transaction.
 */
async function flushRequestLogs() {
  if (requestLogQueue.length === 0) return;

  const batch = [...requestLogQueue];
  requestLogQueue = [];

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
          requestLogQueue = [...batch, ...requestLogQueue]; // Restore queue on error
          return reject(err);
        }

        const stmt = db.prepare(`
          INSERT INTO api_requests (
            user_id, user_email, user_role, ip_address, user_agent,
            method, route, status_code, duration_ms, request_size, response_size,
            success, error_message, metadata_json, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const log of batch) {
          stmt.run([
            log.userId,
            log.userEmail,
            log.userRole,
            log.ipAddress,
            log.userAgent,
            log.method,
            log.route,
            log.statusCode,
            log.durationMs,
            log.requestSize,
            log.responseSize,
            log.success,
            log.errorMessage,
            log.metadataJson,
            log.timestamp
          ]);
        }

        stmt.finalize((finalErr) => {
          if (finalErr) {
            db.run('ROLLBACK');
            requestLogQueue = [...batch, ...requestLogQueue]; // Restore queue
            return reject(finalErr);
          }

          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              requestLogQueue = [...batch, ...requestLogQueue]; // Restore queue
              return reject(commitErr);
            }
            resolve();
          });
        });
      });
    });
  });
}

// Set up periodic flusher interval
const flushInterval = setInterval(() => {
  flushRequestLogs().catch(err => {
    console.error('[AUTO FLUSH ERROR]: Failed to flush request logs:', err.message);
  });
}, FLUSH_INTERVAL_MS);

// Ensure flush on process exit
process.on('SIGINT', async () => {
  clearInterval(flushInterval);
  try {
    console.log('[SHUTDOWN] Flushing request logs before exiting...');
    await flushRequestLogs();
  } catch (err) {
    console.error('[SHUTDOWN ERROR] Failed to flush final logs:', err.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  clearInterval(flushInterval);
  try {
    console.log('[SHUTDOWN] Flushing request logs before exiting...');
    await flushRequestLogs();
  } catch (err) {
    console.error('[SHUTDOWN ERROR] Failed to flush final logs:', err.message);
  }
  process.exit(0);
});

/**
 * Raise Security Alert and write to security_flags
 */
async function raiseSecurityFlag({ type, severity, userId, ipAddress, details }) {
  try {
    // Check if an identical unresolved flag was raised in the last 5 minutes
    const existing = await dbGet(
      `SELECT id FROM security_flags
       WHERE type = ? AND ip_address = ? AND resolved = 0
         AND timestamp > datetime('now', '-5 minutes')`,
      [type, ipAddress]
    );
    if (existing) return; // Prevent spamming duplicate entries

    await dbRun(`
      INSERT INTO security_flags (type, severity, user_id, ip_address, details, resolved)
      VALUES (?, ?, ?, ?, ?, 0)
    `, [type, severity, userId || null, ipAddress || null, details || null]);

    console.warn(`[SECURITY ALERT] Flagged ${type} (${severity}) for IP: ${ipAddress}`);

    // Escalate to Incident Engine if applicable (Phase 9)
    try {
      const { escalateSecurityFlag } = require('./threatEngine');
      const row = await dbGet('SELECT last_insert_rowid() AS id');
      const flagId = row?.id;
      if (flagId) {
        const flag = {
          id: flagId,
          type,
          severity,
          user_id: userId,
          ip_address: ipAddress,
          details
        };
        await escalateSecurityFlag(flag);
      }
    } catch (escErr) {
      console.error('[SECURITY ESCALATION ERROR] Failed to escalate flag:', escErr.message);
    }
  } catch (err) {
    console.error('Failed to raise security flag:', err);
  }
}

/**
 * Rule-based Abuse Detection Engine
 */
function runAbuseDetection(log, req) {
  const ip = log.ipAddress;
  if (!ip) return;

  const now = Date.now();

  // 1. Clean up old timestamps from maps to prevent memory leaks (keep last 15 mins)
  const cutoff = now - 15 * 60 * 1000;
  const filterWindow = (arr) => arr.filter(t => t > cutoff);

  // --- Rule 1: High Request Rate (> 100 requests in 1 minute) ---
  let reqs = ipRequestWindow.get(ip) || [];
  reqs.push(now);
  reqs = filterWindow(reqs);
  ipRequestWindow.set(ip, reqs);

  const oneMinuteAgo = now - 60000;
  const reqsInLastMinute = reqs.filter(t => t > oneMinuteAgo).length;
  if (reqsInLastMinute > 100) {
    raiseSecurityFlag({
      type: 'HIGH_REQUEST_RATE',
      severity: 'MEDIUM',
      userId: log.userId,
      ipAddress: ip,
      details: `IP exceeded request limit with ${reqsInLastMinute} requests in the last minute.`
    });
  }

  // --- Rule 2: Brute Force Attempts (> 5 auth failures in 10 minutes) ---
  const isAuthRoute = log.route && (log.route.includes('/auth/login') || log.route.includes('/auth/verify-otp'));
  const isFailure = log.success === 0 || log.statusCode === 401 || log.statusCode === 403;

  if (isAuthRoute && isFailure) {
    let authFails = ipAuthFailures.get(ip) || [];
    authFails.push(now);
    authFails = filterWindow(authFails);
    ipAuthFailures.set(ip, authFails);

    const tenMinsAgo = now - 10 * 60 * 1000;
    const failsInTenMins = authFails.filter(t => t > tenMinsAgo).length;
    if (failsInTenMins > 5) {
      raiseSecurityFlag({
        type: 'BRUTE_FORCE',
        severity: 'HIGH',
        userId: log.userId,
        ipAddress: ip,
        details: `IP triggered ${failsInTenMins} authentication failures in the last 10 minutes.`
      });
    }
  }

  // --- Rule 3: Repeated Failures (> 10 status 4xx/5xx in 5 minutes, excluding 404) ---
  if (isFailure && log.statusCode !== 404) {
    let genFails = ipGeneralFailures.get(ip) || [];
    genFails.push(now);
    genFails = filterWindow(genFails);
    ipGeneralFailures.set(ip, genFails);

    const fiveMinsAgo = now - 5 * 60 * 1000;
    const failsInFiveMins = genFails.filter(t => t > fiveMinsAgo).length;
    if (failsInFiveMins > 10) {
      raiseSecurityFlag({
        type: 'REPEATED_FAILURES',
        severity: 'MEDIUM',
        userId: log.userId,
        ipAddress: ip,
        details: `IP triggered ${failsInFiveMins} general HTTP errors in the last 5 minutes.`
      });
    }
  }

  // --- Rule 4: Web Scanner / Directory Busting (> 5 404 responses in 5 minutes) ---
  if (log.statusCode === 404) {
    let fails404 = ip404Failures.get(ip) || [];
    fails404.push(now);
    fails404 = filterWindow(fails404);
    ip404Failures.set(ip, fails404);

    const fiveMinsAgo = now - 5 * 60 * 1000;
    const fails404InFiveMins = fails404.filter(t => t > fiveMinsAgo).length;
    if (fails404InFiveMins > 5) {
      raiseSecurityFlag({
        type: 'SUSPICIOUS_IP',
        severity: 'LOW',
        userId: log.userId,
        ipAddress: ip,
        details: `IP triggered ${fails404InFiveMins} 404 Not Found responses in the last 5 minutes. Possible path scanning.`
      });
    }
  }

  // --- Rule 5: Suspicious Payloads (SQL Injection, XSS patterns) ---
  const bodyString = req.body ? JSON.stringify(req.body).toLowerCase() : '';
  const queryString = req.query ? JSON.stringify(req.query).toLowerCase() : '';
  const payloadPatterns = [
    'union select',
    'select * from',
    '<script>',
    'javascript:',
    'etc/passwd',
    '/bin/sh'
  ];
  const matchedPattern = payloadPatterns.find(pat => bodyString.includes(pat) || queryString.includes(pat));
  if (matchedPattern) {
    raiseSecurityFlag({
      type: 'SUSPICIOUS_PAYLOAD',
      severity: 'HIGH',
      userId: log.userId,
      ipAddress: ip,
      details: `IP sent payload matching scan pattern: "${matchedPattern}" in request parameters/body.`
    });
  }
}

module.exports = {
  requestLoggerMiddleware,
  flushRequestLogs,
  raiseSecurityFlag
};
