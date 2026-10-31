const express = require('express');
const { auditLog } = require('./auditLogger');
const { dbAll, dbGet, dbRun } = require('./database');
const {
  ROLES,
  STATUSES,
  normalizeRole,
  normalizeStatus,
  isValidRole,
  isValidStatus,
  roleLevel,
  canChangeUserStatus
} = require('./rbac');
const { requireAuth, requireRole, requireAnyRole } = require('./authMiddleware');

const router = express.Router();

const USER_SELECT = `
  id, name, email, verified, role, status, created_at, last_login
`;

function adminError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function getUserOrThrow(userId) {
  const user = await dbGet(`SELECT ${USER_SELECT} FROM users WHERE id = ?`, [userId]);
  if (!user) throw adminError(404, 'User not found', 'USER_NOT_FOUND');
  return user;
}

async function countOwnersExcluding(userId) {
  const row = await dbGet(
    'SELECT COUNT(*) AS count FROM users WHERE role = ? AND id != ?',
    ['owner', userId]
  );
  return row?.count || 0;
}

async function countActiveOwnersExcluding(userId) {
  const row = await dbGet(
    'SELECT COUNT(*) AS count FROM users WHERE role = ? AND status = ? AND id != ?',
    ['owner', 'active', userId]
  );
  return row?.count || 0;
}

router.use(requireAuth);

// ─── GET /admin/stats ─────────────────────────────────────────────────────────
// Single endpoint for all dashboard KPI widgets. Fast parallel DB queries.
router.get('/stats', requireRole('moderator'), async (req, res, next) => {
  try {
    const now = new Date();
    const fifteenMinsAgo = new Date(now - 15 * 60 * 1000).toISOString();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const oneMinAgo = new Date(now - 60 * 1000).toISOString();

    const [
      totalUsersRow,
      onlineUsersRow,
      totalProgramsRow,
      aiCostTodayRow,
      reqLastMinRow,
      auditTodayRow
    ] = await Promise.all([
      dbGet('SELECT COUNT(*) AS count FROM users'),
      dbGet('SELECT COUNT(*) AS count FROM users WHERE last_login >= ?', [fifteenMinsAgo]),
      dbGet('SELECT COUNT(*) AS count FROM programs'),
      dbGet(
        "SELECT COALESCE(SUM(estimated_cost), 0) AS cost FROM llm_requests WHERE timestamp >= ?",
        [todayStart]
      ),
      dbGet(
        'SELECT COUNT(*) AS count FROM api_requests WHERE timestamp >= ?',
        [oneMinAgo]
      ),
      dbGet(
        'SELECT COUNT(*) AS count FROM audit_logs WHERE timestamp >= ?',
        [todayStart]
      )
    ]);

    res.json({
      ok: true,
      totalUsers: totalUsersRow?.count || 0,
      onlineUsers: onlineUsersRow?.count || 0,
      totalPrograms: totalProgramsRow?.count || 0,
      aiCostToday: aiCostTodayRow?.cost || 0,
      requestsLastMinute: reqLastMinRow?.count || 0,
      auditEventsToday: auditTodayRow?.count || 0
    });
  } catch (err) {
    next(err);
  }
});

router.get('/users', requireRole('moderator'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const params = [];
    let where = '';
    if (search) {
      where = 'WHERE lower(name) LIKE lower(?) OR lower(email) LIKE lower(?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const users = await dbAll(
      `SELECT ${USER_SELECT}
       FROM users
       ${where}
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ ok: true, users, limit, offset });
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', requireRole('moderator'), async (req, res, next) => {
  try {
    const user = await getUserOrThrow(req.params.id);
    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id/programs - get programs created by user
router.get('/users/:id/programs', requireRole('moderator'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { search, limit = 50, offset = 0 } = req.query;
    const parsedLimit = Math.max(1, parseInt(limit, 10));
    const parsedOffset = Math.max(0, parseInt(offset, 10));

    const params = [parseInt(id, 10)];
    let query = 'SELECT * FROM programs WHERE owner_user_id = ? AND deleted_at IS NULL';

    if (search) {
      query += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${search}%`);
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parsedLimit, parsedOffset);

    const programs = await dbAll(query, params);

    res.json({ ok: true, programs });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/role', requireRole('owner'), async (req, res, next) => {
  try {
    const target = await getUserOrThrow(req.params.id);
    const nextRole = normalizeRole(req.body?.role);

    if (!isValidRole(nextRole)) {
      throw adminError(400, `role must be one of: ${ROLES.join(', ')}`, 'INVALID_ROLE');
    }
    if (target.id === req.user.userId && target.role === 'owner' && nextRole !== 'owner') {
      throw adminError(403, 'Owner cannot remove their own owner role', 'OWNER_SELF_PROTECTION');
    }
    if (target.role === 'owner' && nextRole !== 'owner') {
      const remainingOwners = await countOwnersExcluding(target.id);
      if (remainingOwners < 1) {
        throw adminError(409, 'System must contain at least one owner', 'LAST_OWNER_PROTECTION');
      }
    }

    await dbRun('UPDATE users SET role = ? WHERE id = ?', [nextRole, target.id]);
    const user = await getUserOrThrow(target.id);

    // Log role change (Phase 2)
    await auditLog({
      action: 'USER_ROLE_CHANGED',
      targetType: 'user',
      targetId: target.id,
      oldValue: target.role,
      newValue: nextRole,
      metadata: { target_email: target.email }
    });

    if (nextRole === 'owner' && target.role !== 'owner') {
      await auditLog({
        action: 'OWNER_TRANSFERRED',
        targetType: 'user',
        targetId: target.id,
        oldValue: target.role,
        newValue: nextRole,
        metadata: { target_email: target.email }
      });
    }

    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id/status', requireAnyRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const target = await getUserOrThrow(req.params.id);
    const nextStatus = normalizeStatus(req.body?.status);

    if (!isValidStatus(nextStatus)) {
      throw adminError(400, `status must be one of: ${STATUSES.join(', ')}`, 'INVALID_STATUS');
    }
    if (!canChangeUserStatus(req.user, target)) {
      throw adminError(403, 'Insufficient permission to change this user status', 'INSUFFICIENT_ROLE');
    }
    if (target.id === req.user.userId && nextStatus !== 'active') {
      throw adminError(403, 'Administrators cannot restrict their own account', 'SELF_STATUS_PROTECTION');
    }
    if (target.role === 'owner' && nextStatus !== 'active') {
      const remainingActiveOwners = await countActiveOwnersExcluding(target.id);
      if (remainingActiveOwners < 1) {
        throw adminError(409, 'System must contain at least one active owner', 'LAST_OWNER_PROTECTION');
      }
    }
    if (target.role === 'owner' && roleLevel(req.user.role) <= roleLevel(target.role) && target.id !== req.user.userId) {
      throw adminError(403, 'Only a higher role can restrict this account', 'OWNER_PROTECTION');
    }

    await dbRun('UPDATE users SET status = ? WHERE id = ?', [nextStatus, target.id]);

    if (nextStatus === 'banned' || nextStatus === 'disabled') {
      await dbRun('DELETE FROM user_sessions WHERE user_id = ?', [target.id]);
    }

    const user = await getUserOrThrow(target.id);

    // Log status change (Phase 2)
    await auditLog({
      action: 'USER_STATUS_CHANGED',
      targetType: 'user',
      targetId: target.id,
      oldValue: target.status,
      newValue: nextStatus,
      metadata: { target_email: target.email }
    });

    if (nextStatus === 'banned') {
      await auditLog({
        action: 'USER_BANNED',
        targetType: 'user',
        targetId: target.id,
        oldValue: target.status,
        newValue: nextStatus,
        metadata: { target_email: target.email }
      });
    } else if (target.status === 'banned' && nextStatus !== 'banned') {
      await auditLog({
        action: 'USER_UNBANNED',
        targetType: 'user',
        targetId: target.id,
        oldValue: target.status,
        newValue: nextStatus,
        metadata: { target_email: target.email }
      });
    }

    if (nextStatus === 'suspended') {
      await auditLog({
        action: 'USER_SUSPENDED',
        targetType: 'user',
        targetId: target.id,
        oldValue: target.status,
        newValue: nextStatus,
        metadata: { target_email: target.email }
      });
    } else if (target.status === 'suspended' && nextStatus !== 'suspended') {
      await auditLog({
        action: 'USER_UNSUSPENDED',
        targetType: 'user',
        targetId: target.id,
        oldValue: target.status,
        newValue: nextStatus,
        metadata: { target_email: target.email }
      });
    }

    res.json({ ok: true, user });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/users/:id - Delete a user account completely (Owner/Admin only)
router.delete('/users/:id', requireAnyRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const { deleteUserCompletely } = require('./userStorage');
    const { trackActivity } = require('./userActivity');

    const targetUser = await dbGet('SELECT id, email, role FROM users WHERE id = ?', [targetId]);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Owner protection: cannot delete owner accounts, admins cannot delete themselves
    if (targetUser.role === 'owner') {
      return res.status(403).json({ error: 'Owner accounts cannot be deleted', code: 'OWNER_DELETE_PROTECTION' });
    }
    if (targetId === req.user.userId) {
      return res.status(403).json({ error: 'You cannot delete your own account via this endpoint', code: 'SELF_DELETE_PROTECTION' });
    }

    // Perform complete deletion (files + database rows)
    await deleteUserCompletely(targetId);

    // Audit log
    await auditLog({
      action: 'USER_DELETED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: targetId,
      metadata: { targetEmail: targetUser.email, targetRole: targetUser.role }
    });

    // Track activity
    trackActivity({
      userId: req.user.userId,
      userEmail: req.user.email,
      activityType: 'USER_DELETED_BY_ADMIN',
      resourceType: 'user',
      resourceId: targetId
    });

    res.json({ ok: true, message: 'User account and all associated data deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// GET /admin/users/:id/messages - Get administrative messages for user
router.get('/users/:id/messages', requireAnyRole(['owner', 'admin', 'moderator']), async (req, res, next) => {
  try {
    const targetId = req.params.id;
    await getUserOrThrow(targetId);
    const session_id = 'admin_msg_' + targetId;

    const messages = await dbAll(`
      SELECT ch.id, ch.role, ch.content, ch.created_at,
             amr.status, amr.sent_at, amr.delivered_at, amr.read_at,
             amr.sender_admin_id, su.name as sender_name
      FROM chat_history ch
      LEFT JOIN admin_message_receipts amr ON ch.id = amr.message_id
      LEFT JOIN users su ON amr.sender_admin_id = su.id
      WHERE ch.user_id = ? AND ch.session_id = ? AND ch.role = 'admin'
      ORDER BY ch.created_at ASC
    `, [targetId, session_id]);

    res.json({ ok: true, messages });
  } catch (err) {
    next(err);
  }
});

// POST /admin/users/:id/messages - Send administrative message to user
router.post('/users/:id/messages', requireAnyRole(['owner', 'admin', 'moderator']), async (req, res, next) => {
  try {
    const targetId = req.params.id;
    const { content } = req.body;
    await getUserOrThrow(targetId);
    const session_id = 'admin_msg_' + targetId;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    // Ensure the conversation exists and is active
    const conv = await dbGet('SELECT id, status, deleted_at FROM conversations WHERE user_id = ? AND session_id = ?', [targetId, session_id]);
    if (!conv) {
      await dbRun(`
        INSERT INTO conversations (user_id, session_id, title, message_count, status)
        VALUES (?, ?, 'Administration Messages', 0, 'active')
      `, [targetId, session_id]);
    } else if (conv.status === 'deleted' || conv.deleted_at !== null) {
      await dbRun(`
        UPDATE conversations
        SET status = 'active', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [conv.id]);
    }

    // Insert message into chat_history
    const result = await dbRun(
      'INSERT INTO chat_history (session_id, user_id, role, content) VALUES (?, ?, ?, ?)',
      [session_id, targetId, 'admin', content.trim()]
    );
    const messageId = result.lastID;

    // Update conversation message_count and last_message_at
    await dbRun(`
      UPDATE conversations
      SET message_count = message_count + 1, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND session_id = ?
    `, [targetId, session_id]);

    // Create receipt
    await dbRun(
      'INSERT INTO admin_message_receipts (message_id, sender_admin_id, user_id, status) VALUES (?, ?, ?, ?)',
      [messageId, req.user.userId, targetId, 'SENT']
    );

    // Audit log
    await auditLog({
      action: 'ADMIN_MESSAGE_SENT',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'user',
      targetId: targetId,
      metadata: { messageId }
    });

    res.json({ ok: true, message: 'Message sent successfully', messageId });
  } catch (err) {
    next(err);
  }
});

router.use((err, req, res, next) => {
  if (!err) return next();
  console.error('[Admin API Error]:', err);
  res.status(err.status || 500).json({
    error: err.code || 'ADMIN_ERROR',
    message: err.message || 'Admin request failed'
  });
});


// ─── GET /admin/audit ─────────────────────────────────────────────────────────
router.get('/audit', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const params = [];
    const conditions = [];

    // Date range filtering
    if (req.query.startDate) {
      conditions.push('timestamp >= ?');
      params.push(req.query.startDate);
    }
    if (req.query.endDate) {
      conditions.push('timestamp <= ?');
      params.push(req.query.endDate);
    }

    // Action filtering
    if (req.query.action) {
      conditions.push('action = ?');
      params.push(req.query.action);
    }

    // User filtering (by ID or Email)
    if (req.query.userId) {
      conditions.push('actor_user_id = ?');
      params.push(parseInt(req.query.userId, 10));
    }
    if (req.query.email) {
      conditions.push('actor_email = ?');
      params.push(req.query.email);
    }

    // Target filtering
    if (req.query.targetType) {
      conditions.push('target_type = ?');
      params.push(req.query.targetType);
    }
    if (req.query.targetId) {
      conditions.push('target_id = ?');
      params.push(req.query.targetId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const logs = await dbAll(
      `SELECT id, timestamp, actor_user_id, actor_email, actor_role, action, target_type, target_id, old_value, new_value, ip_address, user_agent, success, reason, metadata_json
       FROM audit_logs
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalRow = await dbGet(
      `SELECT COUNT(*) AS count FROM audit_logs ${whereClause}`,
      params
    );

    const formattedLogs = logs.map(log => ({
      ...log,
      success: !!log.success,
      metadata: log.metadata_json ? JSON.parse(log.metadata_json) : null,
      metadata_json: undefined
    }));

    res.json({
      ok: true,
      logs: formattedLogs,
      total: totalRow?.count || 0,
      limit,
      offset
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/audit/:id ─────────────────────────────────────────────────────
router.get('/audit/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const log = await dbGet(
      `SELECT id, timestamp, actor_user_id, actor_email, actor_role, action, target_type, target_id, old_value, new_value, ip_address, user_agent, success, reason, metadata_json
       FROM audit_logs
       WHERE id = ?`,
      [req.params.id]
    );

    if (!log) {
      throw adminError(404, 'Audit log not found', 'AUDIT_LOG_NOT_FOUND');
    }

    const formattedLog = {
      ...log,
      success: !!log.success,
      metadata: log.metadata_json ? JSON.parse(log.metadata_json) : null,
      metadata_json: undefined
    };

    res.json({ ok: true, log: formattedLog });
  } catch (err) {
    next(err);
  }
});


// ─── GET /admin/analytics/requests ───────────────────────────────────────────
router.get('/analytics/requests', requireRole('admin'), async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (startDate) {
      where += ' AND timestamp >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND timestamp <= ?';
      params.push(endDate);
    }

    // Calculate summaries
    const summary = await dbGet(`
      SELECT
        COUNT(*) AS total,
        AVG(duration_ms) AS avgLatency,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS errorRate
      FROM api_requests
      ${where}
    `, params);

    // Daily volume
    const dailyVolume = await dbAll(`
      SELECT
        strftime('%Y-%m-%d', timestamp) AS day,
        COUNT(*) AS count
      FROM api_requests
      ${where}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `, params);

    // Slow requests
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
    const slowRequests = await dbAll(`
      SELECT id, timestamp, user_id, user_email, ip_address, method, route, status_code, duration_ms
      FROM api_requests
      ${where} AND duration_ms > 1000
      ORDER BY duration_ms DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      ok: true,
      summary: {
        totalRequests: summary?.total || 0,
        averageLatencyMs: summary?.avgLatency || 0,
        errorRatePercentage: summary?.errorRate || 0
      },
      dailyVolume,
      slowRequests
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/analytics/endpoints ──────────────────────────────────────────
router.get('/analytics/endpoints', requireRole('admin'), async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (startDate) {
      where += ' AND timestamp >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND timestamp <= ?';
      params.push(endDate);
    }

    const topEndpoints = await dbAll(`
      SELECT method, route, COUNT(*) AS count, AVG(duration_ms) AS avgLatency
      FROM api_requests
      ${where}
      GROUP BY method, route
      ORDER BY count DESC
      LIMIT 20
    `, params);

    const slowestEndpoints = await dbAll(`
      SELECT method, route, AVG(duration_ms) AS avgLatency, COUNT(*) AS count
      FROM api_requests
      ${where}
      GROUP BY method, route
      ORDER BY avgLatency DESC
      LIMIT 20
    `, params);

    const highestErrorRoutes = await dbAll(`
      SELECT
        method, route,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) AS errorRate,
        COUNT(*) AS count
      FROM api_requests
      ${where}
      GROUP BY method, route
      ORDER BY errorRate DESC
      LIMIT 20
    `, params);

    res.json({
      ok: true,
      topEndpoints,
      slowestEndpoints,
      highestErrorRoutes
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/analytics/users ──────────────────────────────────────────────
router.get('/analytics/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (startDate) {
      where += ' AND timestamp >= ?';
      params.push(startDate);
    }
    if (endDate) {
      where += ' AND timestamp <= ?';
      params.push(endDate);
    }

    const topUsers = await dbAll(`
      SELECT user_id, user_email, user_role, COUNT(*) AS count, AVG(duration_ms) AS avgLatency
      FROM api_requests
      ${where} AND user_id IS NOT NULL
      GROUP BY user_id, user_email
      ORDER BY count DESC
      LIMIT 20
    `, params);

    const topIPs = await dbAll(`
      SELECT ip_address, COUNT(*) AS count, AVG(duration_ms) AS avgLatency
      FROM api_requests
      ${where}
      GROUP BY ip_address
      ORDER BY count DESC
      LIMIT 20
    `, params);

    res.json({
      ok: true,
      topUsers,
      topIPs
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/security/flags ───────────────────────────────────────────────
router.get('/security/flags', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const params = [];
    const conditions = [];

    if (req.query.type) {
      conditions.push('type = ?');
      params.push(req.query.type);
    }
    if (req.query.severity) {
      conditions.push('severity = ?');
      params.push(req.query.severity);
    }
    if (req.query.resolved !== undefined) {
      conditions.push('resolved = ?');
      params.push(req.query.resolved === 'true' || req.query.resolved === '1' ? 1 : 0);
    }
    if (req.query.startDate) {
      conditions.push('timestamp >= ?');
      params.push(req.query.startDate);
    }
    if (req.query.endDate) {
      conditions.push('timestamp <= ?');
      params.push(req.query.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const flags = await dbAll(
      `SELECT id, timestamp, type, severity, user_id, ip_address, details, resolved
       FROM security_flags
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalRow = await dbGet(
      `SELECT COUNT(*) AS count FROM security_flags ${whereClause}`,
      params
    );

    res.json({
      ok: true,
      flags,
      total: totalRow?.count || 0,
      limit,
      offset
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /admin/security/flags/:id/resolve ──────────────────────────────────
router.post('/security/flags/:id/resolve', requireRole('admin'), async (req, res, next) => {
  try {
    const flagId = req.params.id;
    const flag = await dbGet('SELECT id FROM security_flags WHERE id = ?', [flagId]);
    if (!flag) {
      throw adminError(404, 'Security flag not found', 'FLAG_NOT_FOUND');
    }

    await dbRun('UPDATE security_flags SET resolved = 1 WHERE id = ?', [flagId]);

    // Log flag resolution in Phase 2 Audit Logs
    await auditLog({
      action: 'SECURITY_FLAG_RESOLVED',
      targetType: 'security_flag',
      targetId: flagId
    });

    res.json({ ok: true, message: `Security flag ${flagId} marked as resolved.` });
  } catch (err) {
    next(err);
  }
});


// ─── GET /admin/activity ──────────────────────────────────────────────────────
router.get('/activity', requireRole('admin'), async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const params = [];
    const conditions = [];

    if (req.query.activityType) {
      conditions.push('activity_type = ?');
      params.push(req.query.activityType);
    }
    if (req.query.resourceType) {
      conditions.push('resource_type = ?');
      params.push(req.query.resourceType);
    }
    if (req.query.userId) {
      conditions.push('user_id = ?');
      params.push(parseInt(req.query.userId, 10));
    }
    if (req.query.email) {
      conditions.push('user_email = ?');
      params.push(req.query.email);
    }
    if (req.query.startDate) {
      conditions.push('timestamp >= ?');
      params.push(req.query.startDate);
    }
    if (req.query.endDate) {
      conditions.push('timestamp <= ?');
      params.push(req.query.endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const activities = await dbAll(
      `SELECT id, timestamp, user_id, user_email, activity_type, resource_type, resource_id, resource_name, ip_address, success, metadata_json
       FROM user_activity
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalRow = await dbGet(
      `SELECT COUNT(*) AS count FROM user_activity ${whereClause}`,
      params
    );

    const formattedActivities = activities.map(act => ({
      ...act,
      success: !!act.success,
      metadata: act.metadata_json ? JSON.parse(act.metadata_json) : null,
      metadata_json: undefined
    }));

    res.json({
      ok: true,
      activities: formattedActivities,
      total: totalRow?.count || 0,
      limit,
      offset
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/activity/:userId ──────────────────────────────────────────────
router.get('/activity/:userId', requireRole('admin'), async (req, res, next) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);

    const params = [userId];
    const conditions = ['user_id = ?'];

    if (req.query.activityType) {
      conditions.push('activity_type = ?');
      params.push(req.query.activityType);
    }
    if (req.query.startDate) {
      conditions.push('timestamp >= ?');
      params.push(req.query.startDate);
    }
    if (req.query.endDate) {
      conditions.push('timestamp <= ?');
      params.push(req.query.endDate);
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const activities = await dbAll(
      `SELECT id, timestamp, user_id, user_email, activity_type, resource_type, resource_id, resource_name, ip_address, success, metadata_json
       FROM user_activity
       ${whereClause}
       ORDER BY timestamp DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const totalRow = await dbGet(
      `SELECT COUNT(*) AS count FROM user_activity ${whereClause}`,
      [userId, ...params.slice(1)]
    );

    const formattedActivities = activities.map(act => ({
      ...act,
      success: !!act.success,
      metadata: act.metadata_json ? JSON.parse(act.metadata_json) : null,
      metadata_json: undefined
    }));

    res.json({
      ok: true,
      user_id: userId,
      timeline: formattedActivities,
      total: totalRow?.count || 0,
      limit,
      offset
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/analytics/activity ────────────────────────────────────────────
router.get('/analytics/activity', requireRole('admin'), async (req, res, next) => {
  try {
    // 1. Most Active Users
    const activeUsers = await dbAll(`
      SELECT user_id, user_email, COUNT(*) AS count
      FROM user_activity
      GROUP BY user_id, user_email
      ORDER BY count DESC
      LIMIT 10
    `);

    // 2. Most Common Activities
    const commonActivities = await dbAll(`
      SELECT activity_type, COUNT(*) AS count
      FROM user_activity
      GROUP BY activity_type
      ORDER BY count DESC
      LIMIT 10
    `);

    // 3. Daily Activity Volume
    const dailyVolume = await dbAll(`
      SELECT strftime('%Y-%m-%d', timestamp) AS day, COUNT(*) AS count
      FROM user_activity
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `);

    // 4. Program Creation Trends
    const programTrends = await dbAll(`
      SELECT strftime('%Y-%m-%d', timestamp) AS day, COUNT(*) AS count
      FROM user_activity
      WHERE activity_type = 'PROGRAM_CREATED'
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `);

    // 5. Execution Trends
    const executionTrends = await dbAll(`
      SELECT strftime('%Y-%m-%d', timestamp) AS day, COUNT(*) AS count
      FROM user_activity
      WHERE activity_type = 'PROGRAM_EXECUTED'
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `);

    res.json({
      ok: true,
      activeUsers,
      commonActivities,
      dailyVolume,
      programTrends,
      executionTrends
    });
  } catch (err) {
    next(err);
  }
});

// ─── ADMIN PROGRAM MODERATION ENDPOINTS (PHASE 5) ─────────────────────────────

// GET /admin/programs - list/search/paginate all programs
router.get('/programs', requireRole('moderator'), async (req, res, next) => {
  try {
    const { ownerId, status, visibility, search, language, limit = 50, offset = 0 } = req.query;
    const parsedLimit = Math.max(1, parseInt(limit, 10));
    const parsedOffset = Math.max(0, parseInt(offset, 10));

    const params = [];
    const conditions = [];

    if (ownerId) {
      conditions.push('p.owner_user_id = ?');
      params.push(parseInt(ownerId, 10));
    }
    if (status) {
      conditions.push('p.status = ?');
      params.push(status);
    } else {
      conditions.push('p.deleted_at IS NULL');
    }
    if (visibility) {
      conditions.push('p.visibility = ?');
      params.push(visibility);
    }
    if (language) {
      conditions.push('p.language = ?');
      params.push(language);
    }
    if (search) {
      conditions.push('(p.name LIKE ? OR p.description LIKE ?)');
      params.push(`%${search}%`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count
      FROM programs p
      ${whereClause}
    `, params);

    const programs = await dbAll(`
      SELECT p.*, u.email AS owner_email, u.name AS owner_name
      FROM programs p
      LEFT JOIN users u ON p.owner_user_id = u.id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      programs,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/programs/:id - get program details & stats
router.get('/programs/:id', requireRole('moderator'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const program = await dbGet(`
      SELECT p.*, u.email AS owner_email, u.name AS owner_name, u.role AS owner_role, u.status AS owner_status
      FROM programs p
      LEFT JOIN users u ON p.owner_user_id = u.id
      WHERE p.id = ?
    `, [id]);

    if (!program) {
      return res.status(404).json({ error: 'Program not found' });
    }

    // Read files in the program directory recursively
    const fs = require('fs');
    const path = require('path');
    const { getUserStoragePaths } = require('./userStorage');
    let files = [];
    try {
      const paths = await getUserStoragePaths(program.owner_user_id);
      const dirPath = path.join(paths.programsRoot, program.name);
      if (fs.existsSync(dirPath)) {
        function getFilesRecursive(dir, base) {
          let list = [];
          const items = fs.readdirSync(dir).filter(item => item !== 'sitecustomize.py');
          for (const item of items) {
            const full = path.join(dir, item);
            const rel = path.relative(base, full).replace(/\\/g, '/');
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              list.push(rel + '/');
              list = list.concat(getFilesRecursive(full, base));
            } else {
              list.push(rel);
            }
          }
          return list;
        }
        files = getFilesRecursive(dirPath, dirPath);
      }
    } catch (err) {
      console.error("[ADMIN ROUTES] Error reading program files:", err);
    }

    res.json({ ok: true, program: { ...program, files } });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/programs/:id/status - enable/disable/suspend status
router.patch('/programs/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'disabled', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const oldProgram = await dbGet('SELECT name, status, owner_user_id FROM programs WHERE id = ?', [id]);
    if (!oldProgram) {
      return res.status(404).json({ error: 'Program not found' });
    }

    await dbRun('UPDATE programs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]);

    // Log to Audit logs (Phase 2)
    await auditLog({
      action: 'PROGRAM_MODERATED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'program',
      targetId: oldProgram.name,
      oldValue: oldProgram.status,
      newValue: status,
      reason: `Admin changed status to ${status}`
    });

    res.json({ ok: true, message: `Program status updated to ${status}` });
  } catch (err) {
    next(err);
  }
});

// DELETE /admin/programs/:id - soft delete a program
router.delete('/programs/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldProgram = await dbGet('SELECT name, status, owner_user_id FROM programs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!oldProgram) {
      return res.status(404).json({ error: 'Program not found or already deleted' });
    }

    await dbRun(
      "UPDATE programs SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );

    // Log to Audit logs
    await auditLog({
      action: 'PROGRAM_DELETED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'program',
      targetId: oldProgram.name,
      oldValue: oldProgram.status,
      newValue: 'deleted',
      reason: 'Admin soft-deleted the program'
    });

    res.json({ ok: true, message: 'Program soft-deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/programs/:id/restore - restore soft-deleted program
router.post('/programs/:id/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldProgram = await dbGet('SELECT name, status, owner_user_id FROM programs WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    if (!oldProgram) {
      return res.status(404).json({ error: 'Program not found or is not deleted' });
    }

    await dbRun(
      "UPDATE programs SET status = 'active', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );

    // Log to Audit logs
    await auditLog({
      action: 'PROGRAM_RESTORED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'program',
      targetId: oldProgram.name,
      oldValue: 'deleted',
      newValue: 'active',
      reason: 'Admin restored the program'
    });

    res.json({ ok: true, message: 'Program restored successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/programs/:id/lock - lock program execution
router.post('/programs/:id/lock', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const program = await dbGet('SELECT name, metadata_json FROM programs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!program) {
      return res.status(404).json({ error: 'Program not found' });
    }

    let meta = {};
    try {
      meta = JSON.parse(program.metadata_json || '{}');
    } catch (_) {}

    meta.locked = true;

    await dbRun('UPDATE programs SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(meta), id]);

    // Log to Audit logs
    await auditLog({
      action: 'PROGRAM_LOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'program',
      targetId: program.name,
      newValue: 'locked',
      reason: 'Admin locked program execution'
    });

    res.json({ ok: true, message: 'Program execution locked successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/programs/:id/unlock - unlock program execution
router.post('/programs/:id/unlock', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const program = await dbGet('SELECT name, metadata_json FROM programs WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!program) {
      return res.status(404).json({ error: 'Program not found' });
    }

    let meta = {};
    try {
      meta = JSON.parse(program.metadata_json || '{}');
    } catch (_) {}

    meta.locked = false;

    await dbRun('UPDATE programs SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(meta), id]);

    // Log to Audit logs
    await auditLog({
      action: 'PROGRAM_UNLOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'program',
      targetId: program.name,
      newValue: 'unlocked',
      reason: 'Admin unlocked program execution'
    });

    res.json({ ok: true, message: 'Program execution unlocked successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── ADMIN CONVERSATION MODERATION ENDPOINTS (PHASE 6) ────────────────────────

// GET /admin/conversations - list/search/paginate all conversations
router.get('/conversations', requireRole('moderator'), async (req, res, next) => {
  try {
    const { userId, email, search, status, startDate, endDate, limit = 50, offset = 0 } = req.query;
    const parsedLimit = Math.max(1, parseInt(limit, 10));
    const parsedOffset = Math.max(0, parseInt(offset, 10));

    const params = [];
    const conditions = [];

    if (userId) {
      conditions.push('c.user_id = ?');
      params.push(parseInt(userId, 10));
    }
    if (email) {
      conditions.push('u.email = ?');
      params.push(email);
    }
    if (status) {
      conditions.push('c.status = ?');
      params.push(status);
    } else {
      conditions.push('c.deleted_at IS NULL');
    }
    if (startDate) {
      conditions.push('c.created_at >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('c.created_at <= ?');
      params.push(endDate);
    }
    if (search) {
      conditions.push('(c.title LIKE ? OR EXISTS (SELECT 1 FROM chat_history h WHERE h.session_id = c.session_id AND h.content LIKE ?))');
      params.push(`%${search}%`);
      params.push(`%${search}%`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count
      FROM conversations c
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
    `, params);

    const conversations = await dbAll(`
      SELECT
        c.id,
        c.user_id,
        c.session_id,
        COALESCE(lm.latest_user_message, c.title, 'Untitled Session') AS title,
        c.created_at,
        c.updated_at,
        c.status,
        c.deleted_at,
        c.metadata_json,
        u.email AS user_email,
        u.name AS user_name,
        COALESCE(h.messages_count, c.message_count, 0) AS messages_count,
        COALESCE(h.messages_count, c.message_count, 0) AS message_count,
        COALESCE(h.real_last_message_at, c.last_message_at, c.updated_at, c.created_at) AS last_message_at,
        COALESCE(h.real_last_message_at, c.last_message_at, c.updated_at, c.created_at) AS last_activity
      FROM conversations c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN (
        SELECT
          session_id,
          COUNT(*) AS messages_count,
          MAX(created_at) AS real_last_message_at
        FROM chat_history
        GROUP BY session_id
      ) h ON h.session_id = c.session_id
      LEFT JOIN (
        SELECT session_id, content AS latest_user_message
        FROM chat_history
        WHERE id IN (
          SELECT MAX(id)
          FROM chat_history
          WHERE role = 'user'
          GROUP BY session_id
        )
      ) lm ON lm.session_id = c.session_id
      ${whereClause}
      ORDER BY COALESCE(h.real_last_message_at, c.last_message_at, c.created_at) DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      conversations,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/conversations/:id - get conversation details & messages
router.get('/conversations/:id', requireRole('moderator'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const conversation = await dbGet(`
      SELECT c.*, u.email AS user_email, u.name AS user_name, u.role AS user_role, u.status AS user_status
      FROM conversations c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.id = ?
    `, [id]);

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const messages = await dbAll(`
      SELECT role, content, created_at
      FROM chat_history
      WHERE session_id = ?
      ORDER BY created_at ASC
    `, [conversation.session_id]);

    res.json({ ok: true, conversation, messages });
  } catch (err) {
    next(err);
  }
});

// POST /admin/conversations/:id/messages - Send message inside a specific user conversation
router.post('/conversations/:id/messages', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    const conv = await dbGet('SELECT * FROM conversations WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Insert message into chat_history
    const result = await dbRun(
      'INSERT INTO chat_history (session_id, user_id, role, content) VALUES (?, ?, ?, ?)',
      [conv.session_id, conv.user_id, 'admin', content.trim()]
    );
    const messageId = result.lastID;

    // Update conversation message_count and last_message_at
    await dbRun(`
      UPDATE conversations
      SET message_count = message_count + 1, last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [conv.id]);

    // Audit log
    await auditLog({
      action: 'ADMIN_CONV_MESSAGE_SENT',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: conv.session_id,
      metadata: { messageId }
    });

    res.json({ ok: true, message: 'Message sent inline successfully', messageId });
  } catch (err) {
    next(err);
  }
});

// PATCH /admin/conversations/:id/status - lock/unlock status
router.patch('/conversations/:id/status', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'locked'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value (must be active or locked)' });
    }

    const oldConv = await dbGet('SELECT session_id, status, user_id FROM conversations WHERE id = ?', [id]);
    if (!oldConv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await dbRun('UPDATE conversations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, id]);

    // Log to Audit Logs
    await auditLog({
      action: 'CONVERSATION_MODERATED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: oldConv.session_id,
      oldValue: oldConv.status,
      newValue: status,
      reason: `Admin changed status to ${status}`
    });

    res.json({ ok: true, message: `Conversation status updated to ${status}` });
  } catch (err) {
    next(err);
  }
});


// DELETE /admin/conversations/:id - soft delete
router.delete('/conversations/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldConv = await dbGet('SELECT session_id, status, user_id FROM conversations WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!oldConv) {
      return res.status(404).json({ error: 'Conversation not found or already deleted' });
    }

    await dbRun(
      "UPDATE conversations SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );

    // Log to Audit Logs
    await auditLog({
      action: 'CONVERSATION_DELETED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: oldConv.session_id,
      oldValue: oldConv.status,
      newValue: 'deleted',
      reason: 'Admin soft-deleted the conversation'
    });

    res.json({ ok: true, message: 'Conversation soft-deleted successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/conversations/:id/restore - restore soft-deleted
router.post('/conversations/:id/restore', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldConv = await dbGet('SELECT session_id, status, user_id FROM conversations WHERE id = ? AND deleted_at IS NOT NULL', [id]);
    if (!oldConv) {
      return res.status(404).json({ error: 'Conversation not found or is not deleted' });
    }

    await dbRun(
      "UPDATE conversations SET status = 'active', deleted_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [id]
    );

    // Log to Audit Logs
    await auditLog({
      action: 'CONVERSATION_RESTORED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: oldConv.session_id,
      oldValue: 'deleted',
      newValue: 'active',
      reason: 'Admin restored the conversation'
    });

    res.json({ ok: true, message: 'Conversation restored successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/conversations/:id/lock - lock conversation
router.post('/conversations/:id/lock', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldConv = await dbGet('SELECT session_id, status, user_id FROM conversations WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!oldConv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await dbRun("UPDATE conversations SET status = 'locked', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);

    // Log to Audit Logs
    await auditLog({
      action: 'CONVERSATION_LOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: oldConv.session_id,
      oldValue: oldConv.status,
      newValue: 'locked',
      reason: 'Admin locked the conversation messaging'
    });

    res.json({ ok: true, message: 'Conversation locked successfully' });
  } catch (err) {
    next(err);
  }
});

// POST /admin/conversations/:id/unlock - unlock conversation
router.post('/conversations/:id/unlock', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const oldConv = await dbGet('SELECT session_id, status, user_id FROM conversations WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!oldConv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    await dbRun("UPDATE conversations SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);

    // Log to Audit Logs
    await auditLog({
      action: 'CONVERSATION_UNLOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'conversation',
      targetId: oldConv.session_id,
      oldValue: oldConv.status,
      newValue: 'active',
      reason: 'Admin unlocked the conversation messaging'
    });

    res.json({ ok: true, message: 'Conversation unlocked successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── ADMIN SYSTEM INFRASTRUCTURE HEALTH ENDPOINTS (PHASE 7) ───────────────────

// GET /admin/system/health - get real-time health metrics of all components
router.get('/system/health', requireRole('admin'), async (req, res, next) => {
  try {
    const { collectAllMetrics } = require('./monitorService');
    const healthData = await collectAllMetrics();

    // Add Main Server health telemetry
    healthData.nodeServer = {
      ok: true,
      latencyMs: 0
    };

    // Populate actual uptime stats
    healthData.nodeServer.uptime = getServiceUptime('nodeServer');
    if (healthData.db) healthData.db.uptime = getServiceUptime('db');
    if (healthData.redis) healthData.redis.uptime = getServiceUptime('redis');
    if (healthData.ollama) healthData.ollama.uptime = getServiceUptime('ollama');
    if (healthData.litellm) healthData.litellm.uptime = getServiceUptime('litellm');
    if (healthData.n8n) healthData.n8n.uptime = getServiceUptime('n8n');
    if (healthData.google) healthData.google.uptime = 'External';

    res.json({
      ok: true,
      health: healthData
    });
  } catch (err) {
    next(err);
  }
});

// Helper to get PID by port on Windows
function getPidByPort(port) {
  try {
    const { execSync } = require('child_process');
    const output = execSync('netstat -ano').toString();
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes('LISTENING') && line.includes(`:${port}`)) {
        const parts = line.trim().split(/\s+/);
        const localAddress = parts[1];
        if (localAddress && (localAddress.endsWith(`:${port}`) || localAddress.endsWith(`]:${port}`))) {
          const pid = parts[parts.length - 1];
          if (pid && !isNaN(pid)) {
            return parseInt(pid, 10);
          }
        }
      }
    }
  } catch (err) {
    console.error(`Error finding PID for port ${port}:`, err);
  }
  return null;
}

// Helper to calculate service uptime on Windows/Docker
function getServiceUptime(serviceName) {
  try {
    const { execSync } = require('child_process');
    let startTimeMs = null;

    if (serviceName === 'nodeServer' || serviceName === 'db') {
      startTimeMs = Date.now() - (process.uptime() * 1000);
    } else if (serviceName === 'redis' || serviceName === 'n8n') {
      const containerName = serviceName === 'redis' ? 'redis-server' : 'n8n-main';
      const out = execSync(`docker inspect -f "{{.State.StartedAt}}" ${containerName}`, { timeout: 2000 }).toString().trim();
      if (out) {
        startTimeMs = new Date(out).getTime();
      }
    } else {
      let port = 0;
      if (serviceName === 'ollama') port = 11434;
      else if (serviceName === 'litellm') port = 4000;

      if (port > 0) {
        const pid = getPidByPort(port);
        if (pid) {
          try {
            const out = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('o')"`, { timeout: 2500 }).toString().trim();
            if (out) {
              startTimeMs = new Date(out).getTime();
            }
          } catch {
            // Fallback if PowerShell query times out
          }
        }
      }
    }

    if (startTimeMs) {
      const diffSec = Math.floor((Date.now() - startTimeMs) / 1000);
      if (diffSec < 0) return '0m';
      const hrs = Math.floor(diffSec / 3600);
      const mins = Math.floor((diffSec % 3600) / 60);
      if (hrs > 0) {
        return `${hrs}h ${mins}m`;
      }
      return `${mins}m`;
    }
  } catch (err) {
    console.error(`Error calculating uptime for ${serviceName}:`, err.message);
  }
  return '—';
}

// POST /admin/services/:serviceName/restart - Restart a service by process termination
router.post('/services/:serviceName/restart', requireAnyRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const { serviceName } = req.params;
    const allowedServices = ['nodeServer', 'redis', 'ollama', 'litellm', 'n8n'];

    if (!allowedServices.includes(serviceName)) {
      return res.status(400).json({ error: 'Service is not restartable or invalid' });
    }

    const startTime = Date.now();
    let restarted = false;

    // Helper function to check if service is healthy again
    const checkServiceHealthy = async () => {
      if (serviceName === 'redis') {
        try {
          const { execSync } = require('child_process');
          const out = execSync('docker inspect -f "{{.State.Running}}" redis-server').toString().trim();
          return out === 'true';
        } catch {
          return false;
        }
      }

      let url = '';
      if (serviceName === 'ollama') {
        url = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      } else if (serviceName === 'litellm') {
        url = (process.env.LITELLM_BASE_URL || 'http://localhost:4000') + '/health/liveness';
      } else if (serviceName === 'n8n') {
        url = 'http://localhost:5678';
      } else if (serviceName === 'nodeServer') {
        return true;
      }

      if (!url) return false;

      try {
        const fetchRes = await fetch(url, { signal: AbortSignal.timeout(1000) });
        return fetchRes.ok;
      } catch {
        return false;
      }
    };

    // 1. Terminate the target process / stop the container
    if (serviceName === 'nodeServer') {
      res.json({
        success: true,
        service: 'nodeServer',
        restarted: true,
        downtimeMs: 0
      });

      setTimeout(() => {
        console.log('[RESTART] Node Server restarting via admin request...');
        process.exit(0);
      }, 500);
      return;
    }

    if (serviceName === 'redis') {
      const { exec } = require('child_process');
      exec('docker stop redis-server');
    } else if (serviceName === 'n8n') {
      const { exec } = require('child_process');
      exec('docker stop n8n');
    } else {
      let port = 0;
      if (serviceName === 'ollama') port = 11434;
      else if (serviceName === 'litellm') port = 4000;

      if (port > 0) {
        const pid = getPidByPort(port);
        if (pid) {
          const { execSync } = require('child_process');
          execSync(`taskkill /F /PID ${pid}`);
        } else {
          const { exec } = require('child_process');
          const imgName = serviceName === 'ollama' ? 'ollama.exe' : 'python.exe';
          exec(`taskkill /F /IM ${imgName}`);
        }
      }
    }

    // 2. Monitor service recovery (up to 20 seconds timeout)
    const timeout = 20000;
    const interval = 1000;
    let elapsed = 0;

    while (elapsed < timeout) {
      await new Promise(r => setTimeout(r, interval));
      elapsed += interval;

      const healthy = await checkServiceHealthy();
      if (healthy) {
        restarted = true;
        break;
      }
    }

    if (restarted) {
      res.json({
        success: true,
        service: serviceName,
        restarted: true,
        downtimeMs: Date.now() - startTime
      });
    } else {
      res.status(504).json({
        success: false,
        service: serviceName,
        error: 'Service failed to recover within timeout'
      });
    }

  } catch (err) {
    next(err);
  }
});

// GET /admin/system/metrics - get historical metrics logs
router.get('/system/metrics', requireRole('admin'), async (req, res, next) => {
  try {
    const { metricName, startDate, endDate, limit = 100, offset = 0 } = req.query;
    const parsedLimit = Math.max(1, parseInt(limit, 10));
    const parsedOffset = Math.max(0, parseInt(offset, 10));

    const params = [];
    const conditions = [];

    if (metricName) {
      conditions.push('metric_name = ?');
      params.push(metricName);
    }
    if (startDate) {
      conditions.push('timestamp >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('timestamp <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count
      FROM system_metrics
      ${whereClause}
    `, params);

    const metrics = await dbAll(`
      SELECT * FROM system_metrics
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      metrics,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/system/alerts - get list of alerts
router.get('/system/alerts', requireRole('admin'), async (req, res, next) => {
  try {
    const { resolved, severity, startDate, endDate, limit = 50, offset = 0 } = req.query;
    const parsedLimit = Math.max(1, parseInt(limit, 10));
    const parsedOffset = Math.max(0, parseInt(offset, 10));

    const params = [];
    const conditions = [];

    if (resolved !== undefined) {
      conditions.push('resolved = ?');
      params.push(parseInt(resolved, 10));
    }
    if (severity) {
      conditions.push('severity = ?');
      params.push(severity);
    }
    if (startDate) {
      conditions.push('timestamp >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('timestamp <= ?');
      params.push(endDate);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count
      FROM system_alerts
      ${whereClause}
    `, params);

    const alerts = await dbAll(`
      SELECT * FROM system_alerts
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      alerts,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/system/alerts/:id/resolve - manually resolve alert
router.post('/system/alerts/:id/resolve', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const alert = await dbGet('SELECT * FROM system_alerts WHERE id = ?', [id]);
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    if (alert.resolved === 1) {
      return res.status(400).json({ error: 'Alert is already resolved' });
    }

    await dbRun('UPDATE system_alerts SET resolved = 1 WHERE id = ?', [id]);

    // Log to Audit logs
    await auditLog({
      action: 'ALERT_RESOLVED_BY_ADMIN',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'alert',
      targetId: alert.title,
      oldValue: 'unresolved',
      newValue: 'resolved',
      reason: 'Admin manually marked alert as resolved'
    });

    res.json({ ok: true, message: 'Alert resolved successfully' });
  } catch (err) {
    next(err);
  }
});

// ─── AI ANALYTICS & MONITORING ENDPOINTS ───────────────────────────────────────

const http = require('http');

// Helper to check HTTP JSON with timeout
function fetchHttpJson(urlStr, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const req = http.get(u, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(data) });
          } catch(e) {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, dataRaw: data.slice(0, 500) });
          }
        });
      });
      req.on('error', err => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    } catch(e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// GET /admin/ai/summary - Top metric cards
router.get('/ai/summary', requireRole('admin'), async (req, res, next) => {
  try {
    const r24h = await dbGet(`
      SELECT COUNT(id) AS count, COALESCE(SUM(estimated_cost), 0) AS cost
      FROM llm_requests
      WHERE timestamp >= datetime('now', '-1 day')
    `);

    const overall = await dbGet(`
      SELECT
        COUNT(id) AS total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_requests,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(input_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
    `);

    const costToday = await dbGet(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS cost
      FROM llm_requests
      WHERE timestamp >= date('now')
    `);

    const costMonth = await dbGet(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS cost
      FROM llm_requests
      WHERE timestamp >= date('now', 'start of month')
    `);

    const totalReqs = overall?.total_requests || 0;
    const succReqs = overall?.successful_requests || 0;
    const failReqs = overall?.failed_requests || 0;
    const successRate = totalReqs > 0 ? (succReqs / totalReqs) * 100 : 100;

    res.json({
      ok: true,
      summary: {
        total_requests_24h: r24h?.count || 0,
        cost_24h: r24h?.cost || 0,
        total_requests_all_time: totalReqs,
        successful_requests: succReqs,
        failed_requests: failReqs,
        success_rate: Math.round(successRate * 10) / 10,
        avg_latency_ms: Math.round(overall?.avg_latency_ms || 0),
        prompt_tokens: overall?.prompt_tokens || 0,
        completion_tokens: overall?.completion_tokens || 0,
        total_tokens: overall?.total_tokens || 0,
        total_cost: overall?.total_cost || 0,
        cost_today: costToday?.cost || 0,
        cost_month: costMonth?.cost || 0
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/usage - Overall and daily AI request/token/latency tracking (Legacy compatible)
router.get('/ai/usage', requireRole('admin'), async (req, res, next) => {
  try {
    const overall = await dbGet(`
      SELECT
        COUNT(id) AS total_requests,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(success), 0) AS success_rate,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
    `);

    const daily = await dbAll(`
      SELECT
        strftime('%Y-%m-%d', timestamp) AS date,
        COUNT(id) AS request_count,
        COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(success), 0) AS success_rate,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
      GROUP BY date
      ORDER BY date DESC
    `);

    res.json({ ok: true, overall, daily });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/providers - Grouped usage & status by provider
router.get('/ai/providers', requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await dbAll(`
      SELECT
        provider,
        COUNT(id) AS request_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_requests,
        COALESCE(SUM(input_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(estimated_cost), 0) AS estimated_cost,
        MAX(timestamp) AS last_used
      FROM llm_requests
      GROUP BY provider
      ORDER BY request_count DESC
    `);

    const { isFreeProvider } = require('./aiService');

    // Add status & model list for each provider
    const providers = await Promise.all(rows.map(async p => {
      const modelsUsed = await dbAll(
        'SELECT DISTINCT model FROM llm_requests WHERE provider = ? ORDER BY model ASC',
        [p.provider]
      );
      const isFree = isFreeProvider(p.provider, '');
      return {
        ...p,
        avg_latency_ms: Math.round(p.avg_latency_ms),
        is_free: isFree,
        cost_display: isFree ? 'Free ($0.00)' : `$${(p.estimated_cost || 0).toFixed(4)}`,
        status: 'Active',
        models: modelsUsed.map(m => m.model)
      };
    }));

    res.json({ ok: true, providers });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/models - Tracking by model name
router.get('/ai/models', requireRole('admin'), async (req, res, next) => {
  try {
    const { isFreeProvider } = require('./aiService');
    const rows = await dbAll(`
      SELECT
        model,
        provider,
        COUNT(id) AS request_count,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_requests,
        COALESCE(SUM(input_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0) AS completion_tokens,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(success), 0) AS success_rate,
        (1.0 - COALESCE(AVG(success), 0)) AS failure_rate,
        COALESCE(SUM(estimated_cost), 0) AS total_cost,
        MAX(timestamp) AS last_used
      FROM llm_requests
      GROUP BY model, provider
      ORDER BY request_count DESC, total_cost DESC
    `);

    const models = rows.map(m => {
      const isFree = isFreeProvider(m.provider, m.model);
      return {
        ...m,
        avg_latency_ms: Math.round(m.avg_latency_ms),
        success_rate: Math.round((m.success_rate || 0) * 1000) / 10,
        is_free: isFree,
        cost_display: isFree ? 'Free' : `$${(m.total_cost || 0).toFixed(4)}`
      };
    });

    res.json({ ok: true, models });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/litellm - LiteLLM proxy status and live config metrics
router.get('/ai/litellm', requireRole('admin'), async (req, res, next) => {
  try {
    const litellmBase = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
    const [liveness, modelInfo] = await Promise.all([
      fetchHttpJson(`${litellmBase}/health/liveness`),
      fetchHttpJson(`${litellmBase}/model/info`)
    ]);

    const isRunning = liveness.ok;

    // Aggregates from llm_requests for LiteLLM
    const dbStats = await dbGet(`
      SELECT
        COUNT(id) AS total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_requests,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
      WHERE lower(provider) LIKE '%litellm%' OR lower(provider) LIKE '%proxy%'
    `);

    // Parse model_info data if returned
    let configuredModels = [];
    let activeProvidersSet = new Set();
    let fallbacks = [];

    if (modelInfo.ok && Array.isArray(modelInfo.data?.data)) {
      modelInfo.data.data.forEach(item => {
        const alias = item.model_name;
        const targetModel = item.litellm_params?.model || '';
        const order = item.litellm_params?.order || 1;
        const providerName = targetModel.split('/')[0] || 'unknown';

        activeProvidersSet.add(providerName);
        configuredModels.push({
          alias,
          target_model: targetModel,
          provider: providerName,
          order,
          timeout: item.litellm_params?.timeout || 30
        });

        if (order > 1) {
          fallbacks.push({ alias, target_model: targetModel, order });
        }
      });
    }

    res.json({
      ok: true,
      status: isRunning ? 'Running' : 'Offline',
      total_requests: dbStats?.total_requests || 0,
      successful_requests: dbStats?.successful_requests || 0,
      failed_requests: dbStats?.failed_requests || 0,
      avg_response_time_ms: Math.round(dbStats?.avg_latency_ms || 0),
      total_tokens: dbStats?.total_tokens || 0,
      total_cost: dbStats?.total_cost || 0,
      active_providers: Array.from(activeProvidersSet),
      configured_providers_count: activeProvidersSet.size,
      configured_models: configuredModels,
      fallback_models: fallbacks,
      routing_strategy: 'simple-shuffle',
      num_retries: 3,
      cache_hit_rate: 'N/A',
      cache_miss_rate: 'N/A'
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/ollama - Local Ollama detection & metrics
router.get('/ai/ollama', requireRole('admin'), async (req, res, next) => {
  try {
    const [tagsRes, psRes] = await Promise.all([
      fetchHttpJson('http://localhost:11434/api/tags'),
      fetchHttpJson('http://localhost:11434/api/ps')
    ]);

    const isRunning = tagsRes.ok;
    const downloadedModels = (tagsRes.ok && Array.isArray(tagsRes.data?.models)) ? tagsRes.data.models : [];
    const activeModels = (psRes.ok && Array.isArray(psRes.data?.models)) ? psRes.data.models : [];

    // Aggregates from database for Ollama
    const dbStats = await dbGet(`
      SELECT
        COUNT(id) AS total_requests,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM llm_requests
      WHERE lower(provider) LIKE '%ollama%' OR lower(model) LIKE '%ollama%' OR lower(model) LIKE '%qwen%' OR lower(model) LIKE '%gemma%'
    `);

    res.json({
      ok: true,
      status: isRunning ? 'Running' : 'Offline',
      available_models_count: downloadedModels.length,
      downloaded_models: downloadedModels.map(m => ({
        name: m.name,
        size_bytes: m.size,
        size_mb: Math.round(m.size / (1024 * 1024)),
        modified_at: m.modified_at,
        details: m.details
      })),
      active_models: activeModels.map(m => ({
        name: m.name,
        size_vram_mb: Math.round((m.size_vram || m.size || 0) / (1024 * 1024)),
        expires_at: m.expires_at,
        details: m.details
      })),
      number_of_requests: dbStats?.total_requests || 0,
      total_tokens: dbStats?.total_tokens || 0,
      avg_latency_ms: Math.round(dbStats?.avg_latency_ms || 0),
      avg_generation_speed: dbStats?.avg_latency_ms ? `${Math.round(10000 / (dbStats.avg_latency_ms || 1))} tok/s` : 'N/A',
      queue_length: 0,
      ram_usage: isRunning ? 'Active' : 'N/A'
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/groq - Groq provider stats & free tier indicator
router.get('/ai/groq', requireRole('admin'), async (req, res, next) => {
  try {
    const isConfigured = !!(process.env.GROQ_API_KEY || true);

    const dbStats = await dbGet(`
      SELECT
        COUNT(id) AS total_requests,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM llm_requests
      WHERE lower(provider) LIKE '%groq%' OR lower(model) LIKE '%groq%' OR lower(model) LIKE '%llama-3.3%'
    `);

    res.json({
      ok: true,
      api_status: isConfigured ? 'Active (Free Tier)' : 'Not Configured',
      tier: 'Free Tier ($0.00)',
      is_free: true,
      configured_models: ['llama-3.3-70b-versatile', 'qwen-2.5-coder-32b', 'llama-3.1-70b-versatile'],
      requests: dbStats?.total_requests || 0,
      total_tokens: dbStats?.total_tokens || 0,
      avg_latency_ms: Math.round(dbStats?.avg_latency_ms || 0),
      estimated_cost: 0
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/timeline - Time series graphs (range = 24h | 7d | 30d | all)
router.get('/ai/timeline', requireRole('admin'), async (req, res, next) => {
  try {
    const { range = '7d' } = req.query;

    let timeFilter = "datetime('now', '-7 days')";
    let groupByFormat = "%Y-%m-%d";

    if (range === '24h') {
      timeFilter = "datetime('now', '-1 day')";
      groupByFormat = "%Y-%m-%d %H:00";
    } else if (range === '30d') {
      timeFilter = "datetime('now', '-30 days')";
      groupByFormat = "%Y-%m-%d";
    } else if (range === 'all') {
      timeFilter = "'2000-01-01'";
      groupByFormat = "%Y-%m-%d";
    }

    const series = await dbAll(`
      SELECT
        strftime('${groupByFormat}', timestamp) AS time_point,
        COUNT(id) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(SUM(input_tokens), 0) AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0) AS completion_tokens,
        COALESCE(AVG(latency_ms), 0) AS latency,
        COALESCE(SUM(estimated_cost), 0) AS cost
      FROM llm_requests
      WHERE timestamp >= ${timeFilter}
      GROUP BY time_point
      ORDER BY time_point ASC
    `);

    res.json({ ok: true, range, series });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/recent - Latest requests log with full detail payload support
router.get('/ai/recent', requireRole('admin'), async (req, res, next) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10), 1), 200);
    const parsedOffset = Math.max(parseInt(offset, 10), 0);

    const countRow = await dbGet('SELECT COUNT(*) AS count FROM llm_requests');

    const requests = await dbAll(`
      SELECT
        r.id,
        r.timestamp,
        r.user_id,
        u.email AS user_email,
        u.name AS user_name,
        r.session_id,
        c.title AS conversation_title,
        r.provider,
        r.model,
        r.prompt_length,
        r.completion_length,
        r.input_tokens,
        r.output_tokens,
        r.total_tokens,
        r.latency_ms,
        r.success,
        r.error,
        r.estimated_cost,
        r.prompt_text,
        r.completion_text
      FROM llm_requests r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN conversations c ON r.session_id = c.session_id AND c.user_id = r.user_id
      ORDER BY r.timestamp DESC
      LIMIT ? OFFSET ?
    `, [parsedLimit, parsedOffset]);

    const { isFreeProvider } = require('./aiService');

    const formatted = requests.map(item => ({
      ...item,
      latency_ms: Math.round(item.latency_ms),
      is_free: isFreeProvider(item.provider, item.model),
      cost_display: isFreeProvider(item.provider, item.model) ? 'Free' : `$${(item.estimated_cost || 0).toFixed(4)}`
    }));

    res.json({
      ok: true,
      requests: formatted,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/health - Real-time provider health dashboard
router.get('/ai/health', requireRole('admin'), async (req, res, next) => {
  try {
    const litellmBase = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
    const [liveness, ollamaRes] = await Promise.all([
      fetchHttpJson(`${litellmBase}/health/liveness`),
      fetchHttpJson('http://localhost:11434/api/tags')
    ]);

    // Query DB for last error & last success per provider
    const providerList = ['LiteLLM', 'Groq', 'Ollama', 'Gemini', 'GitHub', 'OpenRouter', 'OpenAI', 'Anthropic'];

    const health = await Promise.all(providerList.map(async p => {
      const stats = await dbGet(`
        SELECT
          COALESCE(AVG(latency_ms), 0) AS avg_latency,
          MAX(CASE WHEN success = 1 THEN timestamp END) AS last_success,
          MAX(CASE WHEN success = 0 THEN timestamp END) AS last_error_time,
          MAX(CASE WHEN success = 0 THEN error END) AS last_error
        FROM llm_requests
        WHERE lower(provider) LIKE ?
      `, [`%${p.toLowerCase()}%`]);

      let isHealthy = true;
      if (p === 'LiteLLM') isHealthy = liveness.ok;
      if (p === 'Ollama') isHealthy = ollamaRes.ok;

      return {
        provider: p,
        status: isHealthy ? 'Healthy' : 'Offline',
        avg_latency_ms: Math.round(stats?.avg_latency || 0),
        last_success: stats?.last_success || 'N/A',
        last_error: stats?.last_error || 'None',
        rate_limit_remaining: 'Unlimited (Free/Local)'
      };
    }));

    res.json({ ok: true, health });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/costs - Spend breakdowns grouped by day, model, user, conversation
router.get('/ai/costs', requireRole('admin'), async (req, res, next) => {
  try {
    const byDay = await dbAll(`
      SELECT
        strftime('%Y-%m-%d', timestamp) AS date,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
      GROUP BY date
      ORDER BY date DESC
    `);

    const byModel = await dbAll(`
      SELECT
        model,
        provider,
        COALESCE(SUM(estimated_cost), 0) AS total_cost
      FROM llm_requests
      GROUP BY model, provider
      ORDER BY total_cost DESC
    `);

    const byUser = await dbAll(`
      SELECT
        r.user_id,
        u.email AS user_email,
        u.name AS user_name,
        COALESCE(SUM(r.estimated_cost), 0) AS total_cost
      FROM llm_requests r
      LEFT JOIN users u ON r.user_id = u.id
      GROUP BY r.user_id
      ORDER BY total_cost DESC
    `);

    const byConversation = await dbAll(`
      SELECT
        r.session_id,
        c.title AS conversation_title,
        u.email AS user_email,
        COALESCE(SUM(r.estimated_cost), 0) AS total_cost,
        COUNT(r.id) AS request_count
      FROM llm_requests r
      LEFT JOIN users u ON r.user_id = u.id
      LEFT JOIN conversations c ON r.session_id = c.session_id AND c.user_id = r.user_id
      WHERE r.session_id IS NOT NULL
      GROUP BY r.session_id
      ORDER BY total_cost DESC, request_count DESC
    `);

    res.json({ ok: true, by_day: byDay, by_model: byModel, by_user: byUser, by_conversation: byConversation });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/users - Cost and token utilization by user
router.get('/ai/users', requireRole('admin'), async (req, res, next) => {
  try {
    const users = await dbAll(`
      SELECT
        r.user_id,
        u.email AS user_email,
        u.name AS user_name,
        COUNT(r.id) AS request_count,
        COALESCE(SUM(r.input_tokens), 0) AS total_input_tokens,
        COALESCE(SUM(r.output_tokens), 0) AS total_output_tokens,
        COALESCE(SUM(r.total_tokens), 0) AS total_tokens,
        COALESCE(AVG(r.latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(r.success), 0) AS success_rate,
        COALESCE(SUM(r.estimated_cost), 0) AS total_cost
      FROM llm_requests r
      LEFT JOIN users u ON r.user_id = u.id
      GROUP BY r.user_id
      ORDER BY total_cost DESC, request_count DESC
    `);

    res.json({ ok: true, users });
  } catch (err) {
    next(err);
  }
});

// GET /admin/ai/breakdown - Data for pie/bar usage charts
router.get('/ai/breakdown', requireRole('admin'), async (req, res, next) => {
  try {
    const byProvider = await dbAll(`
      SELECT
        provider,
        COUNT(id) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(success), 0) * 100 AS success_rate
      FROM llm_requests
      GROUP BY provider
      ORDER BY requests DESC
    `);

    const byModel = await dbAll(`
      SELECT
        model,
        provider,
        COUNT(id) AS requests,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COALESCE(AVG(latency_ms), 0) AS avg_latency_ms,
        COALESCE(AVG(success), 0) * 100 AS success_rate
      FROM llm_requests
      GROUP BY model, provider
      ORDER BY requests DESC
    `);

    res.json({ ok: true, by_provider: byProvider, by_model: byModel });
  } catch (err) {
    next(err);
  }
});

// GET /admin/security/incidents - List and filter security incidents
router.get('/security/incidents', requireRole('admin'), async (req, res, next) => {
  try {
    const { status, severity, source, user_id, ip_address, limit = '50', offset = '0' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10), 1), 200);
    const parsedOffset = Math.max(parseInt(offset, 10), 0);

    // Dynamic scan to escalate any new events before listing
    const { scanLogsForIncidents } = require('./threatEngine');
    await scanLogsForIncidents();

    const params = [];
    let whereClauses = [];

    if (status) {
      whereClauses.push('status = ?');
      params.push(status);
    }
    if (severity) {
      whereClauses.push('severity = ?');
      params.push(severity);
    }
    if (source) {
      whereClauses.push('source = ?');
      params.push(source);
    }
    if (user_id) {
      whereClauses.push('user_id = ?');
      params.push(parseInt(user_id, 10));
    }
    if (ip_address) {
      whereClauses.push('ip_address = ?');
      params.push(ip_address);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count FROM security_incidents
      ${whereSql}
    `, params);

    const incidents = await dbAll(`
      SELECT * FROM security_incidents
      ${whereSql}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      incidents,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/security/ip/:ip - Get IP reputation and ban status
router.get('/security/ip/:ip', requireRole('admin'), async (req, res, next) => {
  try {
    const { ip } = req.params;
    const { checkIpReputation } = require('./threatEngine');

    const reputation = await checkIpReputation(ip);
    const ban = await dbGet(`
      SELECT * FROM banned_ips
      WHERE ip = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
      LIMIT 1
    `, [ip]);

    res.json({
      ok: true,
      reputation,
      ban
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/security/ip/ban - Ban an IP address (temporary or permanent)
router.post('/security/ip/ban', requireRole('admin'), async (req, res, next) => {
  try {
    const { ip, reason, duration_seconds } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'ip is required' });
    }

    let expiresAt = null;
    if (duration_seconds) {
      const seconds = parseInt(duration_seconds, 10);
      if (!isNaN(seconds) && seconds > 0) {
        const date = new Date(Date.now() + seconds * 1000);
        expiresAt = date.toISOString().replace('T', ' ').substring(0, 19);
      }
    }

    await dbRun(`
      INSERT OR REPLACE INTO banned_ips (ip, expires_at, reason, banned_by)
      VALUES (?, ?, ?, ?)
    `, [ip, expiresAt, reason || null, req.user.userId]);

    const ban = await dbGet('SELECT * FROM banned_ips WHERE ip = ?', [ip]);

    // Log to Audit Log
    await auditLog({
      action: 'IP_BANNED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'ip',
      targetId: ip,
      newValue: expiresAt || 'permanent',
      reason: reason || 'Admin action'
    });

    res.json({
      ok: true,
      message: `IP ${ip} banned successfully`,
      ban
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/security/ip/unban - Unban an IP address
router.post('/security/ip/unban', requireRole('admin'), async (req, res, next) => {
  try {
    const { ip } = req.body;
    if (!ip) {
      return res.status(400).json({ error: 'ip is required' });
    }

    const existingBan = await dbGet('SELECT * FROM banned_ips WHERE ip = ?', [ip]);
    if (!existingBan) {
      return res.status(404).json({ error: 'IP is not banned' });
    }

    await dbRun('DELETE FROM banned_ips WHERE ip = ?', [ip]);

    // Log to Audit Log
    await auditLog({
      action: 'IP_UNBANNED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'ip',
      targetId: ip,
      reason: 'Admin action unban'
    });

    res.json({
      ok: true,
      message: `IP ${ip} unbanned successfully`
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/security/reputation - Search IP reputation database
router.get('/security/reputation', requireRole('admin'), async (req, res, next) => {
  try {
    const { limit = '50', offset = '0', search } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10), 1), 200);
    const parsedOffset = Math.max(parseInt(offset, 10), 0);

    const params = [];
    let whereSql = '';
    if (search) {
      whereSql = 'WHERE ip LIKE ? OR country LIKE ? OR city LIKE ? OR asn LIKE ?';
      const searchParam = `%${search}%`;
      params.push(searchParam, searchParam, searchParam, searchParam);
    }

    const countRow = await dbGet(`
      SELECT COUNT(*) AS count FROM ip_reputation
      ${whereSql}
    `, params);

    const reputations = await dbAll(`
      SELECT * FROM ip_reputation
      ${whereSql}
      ORDER BY last_checked DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      reputations,
      total: countRow?.count || 0,
      limit: parsedLimit,
      offset: parsedOffset
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/security/device/block - Block a device fingerprint
router.post('/security/device/block', requireRole('admin'), async (req, res, next) => {
  try {
    const { device_fingerprint, reason } = req.body;
    if (!device_fingerprint) {
      return res.status(400).json({ error: 'device_fingerprint is required' });
    }

    await dbRun(`
      INSERT OR REPLACE INTO blocked_devices (device_fingerprint, reason, blocked_by)
      VALUES (?, ?, ?)
    `, [device_fingerprint, reason || null, req.user.userId]);

    await auditLog({
      action: 'DEVICE_BLOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'device',
      targetId: device_fingerprint,
      reason: reason || 'Admin action'
    });

    res.json({
      ok: true,
      message: `Device ${device_fingerprint} blocked successfully`
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/security/device/unblock - Unblock a device fingerprint
router.post('/security/device/unblock', requireRole('admin'), async (req, res, next) => {
  try {
    const { device_fingerprint } = req.body;
    if (!device_fingerprint) {
      return res.status(400).json({ error: 'device_fingerprint is required' });
    }

    const existingBlock = await dbGet('SELECT * FROM blocked_devices WHERE device_fingerprint = ?', [device_fingerprint]);
    if (!existingBlock) {
      return res.status(404).json({ error: 'Device is not blocked' });
    }

    await dbRun('DELETE FROM blocked_devices WHERE device_fingerprint = ?', [device_fingerprint]);

    await auditLog({
      action: 'DEVICE_UNBLOCKED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'device',
      targetId: device_fingerprint,
      reason: 'Admin action unblock'
    });

    res.json({
      ok: true,
      message: `Device ${device_fingerprint} unblocked successfully`
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/security/incidents/:id/resolve - Mark a security incident as resolved
router.post('/security/incidents/:id/resolve', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const incident = await dbGet('SELECT * FROM security_incidents WHERE id = ?', [id]);
    if (!incident) {
      return res.status(404).json({ error: 'Incident not found' });
    }

    await dbRun(`
      UPDATE security_incidents
      SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, resolution_notes = ?
      WHERE id = ?
    `, [req.user.userId, notes || null, id]);

    await auditLog({
      action: 'SECURITY_INCIDENT_RESOLVED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: 'incident',
      targetId: id,
      reason: notes || 'Admin resolved incident'
    });

    res.json({
      ok: true,
      message: `Incident #${id} resolved successfully`
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/search - Universal platform-wide administrative search
router.get('/search', requireRole('admin'), async (req, res, next) => {
  try {
    const { q, limit = '20', offset = '0' } = req.query;
    const { globalSearch } = require('./searchService');

    const result = await globalSearch(q, limit, offset);
    res.json({
      ok: true,
      ...result
    });
  } catch (err) {
    next(err);
  }
});

// POST /admin/notes - Write an admin note on a resource
router.post('/notes', requireRole('admin'), async (req, res, next) => {
  try {
    const { target_type, target_id, content } = req.body;
    if (!target_type || !target_id || !content) {
      return res.status(400).json({ error: 'target_type, target_id, and content are required' });
    }

    await dbRun(`
      INSERT INTO admin_notes (user_id, target_type, target_id, content)
      VALUES (?, ?, ?, ?)
    `, [req.user.userId, target_type, target_id, content]);

    const row = await dbGet('SELECT last_insert_rowid() AS id');
    const noteId = row?.id;

    // Log to Audit Log
    await auditLog({
      action: 'ADMIN_NOTE_CREATED',
      actorId: req.user.userId,
      actorEmail: req.user.email,
      actorRole: req.user.role,
      targetType: target_type,
      targetId: target_id,
      newValue: content,
      reason: 'Admin annotated resource'
    });

    res.status(201).json({
      ok: true,
      message: 'Admin note created successfully',
      note: {
        id: noteId,
        user_id: req.user.userId,
        target_type,
        target_id,
        content
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /admin/notes - List admin notes on a resource
router.get('/notes', requireRole('admin'), async (req, res, next) => {
  try {
    const { target_type, target_id, limit = '50', offset = '0' } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10), 1), 200);
    const parsedOffset = Math.max(parseInt(offset, 10), 0);

    const params = [];
    let whereClauses = [];

    if (target_type) {
      whereClauses.push('target_type = ?');
      params.push(target_type);
    }
    if (target_id) {
      whereClauses.push('target_id = ?');
      params.push(target_id);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const notes = await dbAll(`
      SELECT * FROM admin_notes
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parsedLimit, parsedOffset]);

    res.json({
      ok: true,
      notes
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
