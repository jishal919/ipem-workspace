const { dbAll } = require('./database');

/**
 * Universal Global Admin Search Service.
 * Matches case-insensitively across multiple platform tables.
 */
async function globalSearch(query, limit = 20, offset = 0) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      users: [],
      programs: [],
      conversations: [],
      audit_logs: [],
      incidents: [],
      flags: [],
      ips: [],
      notes: []
    };
  }

  const cleanQuery = `%${query.trim()}%`;
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const params = [cleanQuery, parsedLimit, parsedOffset];

  try {
    // 1. Search Users (Name, Email)
    const usersPromise = dbAll(`
      SELECT id, name, email, verified, role, status, created_at, last_login
      FROM users
      WHERE name LIKE ? OR email LIKE ?
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 2. Search Programs (Name, Description, Language)
    const programsPromise = dbAll(`
      SELECT id, owner_user_id, name, description, language, created_at, execution_count, status, visibility
      FROM programs
      WHERE name LIKE ? OR description LIKE ? OR language LIKE ?
      ORDER BY name ASC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 3. Search Conversations (Title, Session ID)
    const conversationsPromise = dbAll(`
      SELECT id, user_id, session_id, title, message_count, created_at, status
      FROM conversations
      WHERE title LIKE ? OR session_id LIKE ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 4. Search Audit Logs (Action, Reason, Actor Email, Target ID)
    const auditLogsPromise = dbAll(`
      SELECT id, timestamp, action, actor_user_id, actor_email, actor_role, target_type, target_id, reason
      FROM audit_logs
      WHERE action LIKE ? OR reason LIKE ? OR actor_email LIKE ? OR target_id LIKE ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 5. Search Security Incidents (Title, Description, IP Address)
    const incidentsPromise = dbAll(`
      SELECT id, timestamp, title, description, severity, status, user_id, ip_address, device_fingerprint, source
      FROM security_incidents
      WHERE title LIKE ? OR description LIKE ? OR ip_address LIKE ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 6. Search Security Flags (Type, IP Address, Details)
    const flagsPromise = dbAll(`
      SELECT id, timestamp, type, severity, user_id, ip_address, details, resolved
      FROM security_flags
      WHERE type LIKE ? OR ip_address LIKE ? OR details LIKE ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 7. Search IP Reputation records (IP, Country, City, ASN)
    const ipsPromise = dbAll(`
      SELECT ip, score, is_vpn, is_proxy, is_datacenter, country, city, asn, last_checked
      FROM ip_reputation
      WHERE ip LIKE ? OR country LIKE ? OR city LIKE ? OR asn LIKE ?
      ORDER BY last_checked DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // 8. Search Admin Notes (Content, Target Type, Target ID)
    const notesPromise = dbAll(`
      SELECT id, user_id, target_type, target_id, content, created_at, updated_at
      FROM admin_notes
      WHERE content LIKE ? OR target_type LIKE ? OR target_id LIKE ?
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `, [cleanQuery, cleanQuery, cleanQuery, parsedLimit, parsedOffset]);

    // Await all queries in parallel
    const [
      users,
      programs,
      conversations,
      auditLogs,
      incidents,
      flags,
      ips,
      notes
    ] = await Promise.all([
      usersPromise,
      programsPromise,
      conversationsPromise,
      auditLogsPromise,
      incidentsPromise,
      flagsPromise,
      ipsPromise,
      notesPromise
    ]);

    return {
      users,
      programs,
      conversations,
      audit_logs: auditLogs,
      incidents,
      flags,
      ips,
      notes
    };
  } catch (err) {
    console.error('[SEARCH SERVICE ERROR] Universal search failed:', err.message);
    throw err;
  }
}

module.exports = {
  globalSearch
};
