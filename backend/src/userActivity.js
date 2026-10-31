const { db } = require('./database');
const { auditStorage } = require('./auditLogger');

let activityQueue = [];
const BATCH_SIZE_LIMIT = 50;
const FLUSH_INTERVAL_MS = 3000;

/**
 * trackActivity — Pushes a business-level activity log into the in-memory queue.
 * Automatically resolves missing userId, userEmail, and ipAddress from request storage context if active.
 */
function trackActivity({
  userId,
  userEmail,
  activityType,
  resourceType = null,
  resourceId = null,
  resourceName = null,
  metadata = null,
  ipAddress,
  success = 1
}) {
  const context = auditStorage.getStore() || {};

  const finalUserId = userId !== undefined ? userId : (context.actor_user_id || null);
  const finalUserEmail = userEmail !== undefined ? userEmail : (context.actor_email || null);
  const finalIpAddress = ipAddress !== undefined ? ipAddress : (context.ip_address || null);

  const metadataStr = metadata ? JSON.stringify(metadata) : null;
  const dbSuccess = success ? 1 : 0;

  activityQueue.push({
    userId: finalUserId,
    userEmail: finalUserEmail,
    activityType,
    resourceType,
    resourceId: resourceId !== null && resourceId !== undefined ? String(resourceId) : null,
    resourceName,
    metadataJson: metadataStr,
    ipAddress: finalIpAddress,
    success: dbSuccess,
    timestamp: new Date().toISOString()
  });

  if (activityQueue.length >= BATCH_SIZE_LIMIT) {
    flushActivityLogs().catch(err => console.error('[ACTIVITY FLUSH ERROR]:', err));
  }
}

/**
 * flushActivityLogs — Writes buffered activity logs in a single transaction.
 */
async function flushActivityLogs() {
  if (activityQueue.length === 0) return;

  const batch = [...activityQueue];
  activityQueue = [];

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) {
          activityQueue = [...batch, ...activityQueue]; // Restore queue
          return reject(err);
        }

        const stmt = db.prepare(`
          INSERT INTO user_activity (
            user_id, user_email, activity_type, resource_type, resource_id, resource_name,
            metadata_json, ip_address, success, timestamp
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const act of batch) {
          stmt.run([
            act.userId,
            act.userEmail,
            act.activityType,
            act.resourceType,
            act.resourceId,
            act.resourceName,
            act.metadataJson,
            act.ipAddress,
            act.success,
            act.timestamp
          ]);
        }

        stmt.finalize((finalErr) => {
          if (finalErr) {
            db.run('ROLLBACK');
            activityQueue = [...batch, ...activityQueue]; // Restore queue
            return reject(finalErr);
          }

          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              activityQueue = [...batch, ...activityQueue]; // Restore queue
              return reject(commitErr);
            }
            resolve();
          });
        });
      });
    });
  });
}

// Start auto-flushing interval
const flushInterval = setInterval(() => {
  flushActivityLogs().catch(err => {
    console.error('[ACTIVITY AUTO FLUSH ERROR]:', err.message);
  });
}, FLUSH_INTERVAL_MS);

// Shutdown hooks
process.on('SIGINT', async () => {
  clearInterval(flushInterval);
  try {
    console.log('[SHUTDOWN] Flushing activity logs before exiting...');
    await flushActivityLogs();
  } catch (err) {
    console.error('[SHUTDOWN ERROR] Failed to flush final activity logs:', err.message);
  }
});

process.on('SIGTERM', async () => {
  clearInterval(flushInterval);
  try {
    console.log('[SHUTDOWN] Flushing activity logs before exiting...');
    await flushActivityLogs();
  } catch (err) {
    console.error('[SHUTDOWN ERROR] Failed to flush final activity logs:', err.message);
  }
});

module.exports = {
  trackActivity,
  flushActivityLogs
};
