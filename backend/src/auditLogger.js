const { dbRun } = require('./database');
const { AsyncLocalStorage } = require('async_hooks');

const auditStorage = new AsyncLocalStorage();

/**
 * Reusable audit logging service.
 * Records security-sensitive and admin actions.
 * Logs are append-only and immutable.
 */
async function auditLog({
  action,
  actorId,
  actorEmail,
  actorRole,
  targetType,
  targetId,
  oldValue,
  newValue,
  ipAddress,
  userAgent,
  success = true,
  reason = null,
  metadata = null
}) {
  // 1. Resolve context from AsyncLocalStorage if active
  const context = auditStorage.getStore() || {};

  // 2. Prioritize explicitly passed parameters, fall back to storage context
  const finalActorId = actorId !== undefined ? actorId : (context.actor_user_id || null);
  const finalActorEmail = actorEmail !== undefined ? actorEmail : (context.actor_email || null);
  const finalActorRole = actorRole !== undefined ? actorRole : (context.actor_role || null);
  const finalIpAddress = ipAddress !== undefined ? ipAddress : (context.ip_address || null);
  const finalUserAgent = userAgent !== undefined ? userAgent : (context.user_agent || null);

  // 3. Cast values to safe SQLite representations
  const dbSuccess = success ? 1 : 0;
  const oldValueStr = oldValue !== null && oldValue !== undefined ? String(oldValue) : null;
  const newValueStr = newValue !== null && newValue !== undefined ? String(newValue) : null;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  try {
    await dbRun(`
      INSERT INTO audit_logs (
        actor_user_id, actor_email, actor_role,
        action, target_type, target_id,
        old_value, new_value, ip_address, user_agent,
        success, reason, metadata_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `, [
      finalActorId,
      finalActorEmail,
      finalActorRole,
      action,
      targetType || null,
      targetId !== null && targetId !== undefined ? String(targetId) : null,
      oldValueStr,
      newValueStr,
      finalIpAddress,
      finalUserAgent,
      dbSuccess,
      reason,
      metadataStr
    ]);
  } catch (err) {
    // Prevent failure in audit logging from crashing the main user request thread,
    // but log it to stdout/stderr.
    console.error(`[AUDIT ERROR] Failed to write audit log for action ${action}:`, err.message);
  }
}

module.exports = {
  auditLog,
  auditStorage
};
