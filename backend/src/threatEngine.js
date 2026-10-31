const crypto = require('crypto');
const { dbGet, dbAll, dbRun } = require('./database');
const { auditLog } = require('./auditLogger');

/**
 * Extracts or generates a device fingerprint from request headers, cookies, query, or body.
 * Falls back to sha256(ip + user-agent) if not explicitly provided.
 */
function getDeviceFingerprint(req) {
  let fingerprint = req.headers['x-device-fingerprint'] ||
                    req.query.device_fingerprint ||
                    req.body?.device_fingerprint;

  if (!fingerprint && req.cookies) {
    fingerprint = req.cookies['ipem_device_id'];
  }

  if (!fingerprint) {
    // Generate fallback fingerprint
    const ip = req.headers['x-forwarded-for']
      ? req.headers['x-forwarded-for'].split(',')[0].trim()
      : req.ip || req.socket.remoteAddress || '127.0.0.1';
    const ua = req.headers['user-agent'] || 'unknown-agent';

    fingerprint = crypto.createHash('sha256').update(`${ip}:${ua}`).digest('hex');
  }

  return fingerprint;
}

/**
 * IP Reputation checker. Retrieves IP reputation cache or populates it via mock intelligence rules.
 */
async function checkIpReputation(ip) {
  if (!ip) return null;

  try {
    let rep = await dbGet('SELECT * FROM ip_reputation WHERE ip = ?', [ip]);
    if (rep) return rep;

    // Run Mock Intelligence Rules for Local/Offline Testing
    let score = 0.0;
    let isVpn = 0;
    let isProxy = 0;
    let isDatacenter = 0;
    let country = 'US';
    let city = 'New York';
    let latitude = 40.7128;
    let longitude = -74.0060;
    let asn = 'AS15169 Google LLC';

    // 1. Safe localhost/private networks
    if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
      city = 'Local Network';
      country = 'US';
      latitude = 40.7128;
      longitude = -74.0060;
    } else {
      // 2. Specific test triggers based on IP address patterns
      if (ip.includes('.77') || ip.toLowerCase().includes('vpn')) {
        isVpn = 1;
        score = 0.5;
        country = 'DE';
        city = 'Frankfurt';
        latitude = 50.1109;
        longitude = 8.6821;
        asn = 'AS12345 VPN Provider Inc.';
      } else if (ip.includes('.88') || ip.toLowerCase().includes('proxy')) {
        isProxy = 1;
        score = 0.7;
        country = 'NL';
        city = 'Amsterdam';
        latitude = 52.3676;
        longitude = 4.9041;
        asn = 'AS67890 Proxy Servers LLC';
      } else if (ip.includes('.99') || ip.toLowerCase().includes('datacenter')) {
        isDatacenter = 1;
        score = 0.4;
        country = 'US';
        city = 'Ashburn';
        latitude = 39.0438;
        longitude = -77.4874;
        asn = 'AS20940 Amazon Data Services';
      } else if (ip.toLowerCase().includes('travel') || ip.includes('.101')) {
        // Mock Travel destination (Tokyo)
        country = 'JP';
        city = 'Tokyo';
        latitude = 35.6762;
        longitude = 139.6503;
        asn = 'AS2500 Tokyo Telecom';
      } else if (ip.toLowerCase().includes('london') || ip.includes('.102')) {
        // Mock travel London
        country = 'GB';
        city = 'London';
        latitude = 51.5074;
        longitude = -0.1278;
        asn = 'AS3300 British Telecom';
      }
    }

    rep = {
      ip,
      score,
      is_vpn: isVpn,
      is_proxy: isProxy,
      is_datacenter: isDatacenter,
      country,
      city,
      latitude,
      longitude,
      asn,
      metadata_json: JSON.stringify({ source: 'mock_ip_intel' })
    };

    await dbRun(`
      INSERT OR REPLACE INTO ip_reputation (
        ip, score, is_vpn, is_proxy, is_datacenter, country, city, latitude, longitude, asn, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      rep.ip,
      rep.score,
      rep.is_vpn,
      rep.is_proxy,
      rep.is_datacenter,
      rep.country,
      rep.city,
      rep.latitude,
      rep.longitude,
      rep.asn,
      rep.metadata_json
    ]);

    return rep;
  } catch (err) {
    console.error(`[THREAT ENGINE] Failed checkIpReputation for IP ${ip}:`, err.message);
    return null;
  }
}

/**
 * Creates a security incident entry and logs it to audit trail.
 */
async function createIncident({
  title,
  description,
  severity,
  userId = null,
  ipAddress = null,
  deviceFingerprint = null,
  source,
  sourceId = null,
  detailsJson = '{}'
}) {
  try {
    const isStatus = 'open';
    const timestamp = new Date().toISOString();

    const result = await dbRun(`
      INSERT INTO security_incidents (
        timestamp, title, description, severity, status, user_id, ip_address, device_fingerprint, source, source_id, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      timestamp,
      title,
      description,
      severity,
      isStatus,
      userId,
      ipAddress,
      deviceFingerprint,
      source,
      sourceId,
      typeof detailsJson === 'string' ? detailsJson : JSON.stringify(detailsJson)
    ]);

    // Query the newly inserted ID (retrieve last row ID in SQLite)
    const row = await dbGet('SELECT last_insert_rowid() AS id');
    const incidentId = row?.id;

    // Publish to Audit Logger
    await auditLog({
      action: 'SECURITY_INCIDENT_RAISED',
      actorId: userId || 0,
      actorEmail: 'system@ipem.security',
      actorRole: 'system',
      targetType: 'incident',
      targetId: incidentId || title,
      newValue: severity,
      reason: title
    });

    console.warn(`[THREAT INCIDENT #${incidentId}] ${severity}: ${title} - ${description}`);
    return { id: incidentId, title, severity, timestamp };
  } catch (err) {
    console.error('[THREAT ENGINE] Failed to create incident:', err.message);
    return null;
  }
}

/**
 * Escalate a high-severity security_flag record to a security_incidents record.
 */
async function escalateSecurityFlag(flag) {
  if (!flag) return;

  const severityMap = {
    'CRITICAL': 'CRITICAL',
    'HIGH': 'HIGH',
    'MEDIUM': 'MEDIUM',
    'LOW': 'LOW',
    'INFO': 'INFO'
  };

  const incidentSeverity = severityMap[flag.severity] || 'MEDIUM';

  // Automatically elevate HIGH/CRITICAL flags
  if (flag.severity === 'HIGH' || flag.severity === 'CRITICAL') {
    await createIncident({
      title: `Escalated Flag: ${flag.type}`,
      description: flag.details || `Security flag ${flag.type} was escalated automatically.`,
      severity: incidentSeverity,
      userId: flag.user_id,
      ipAddress: flag.ip_address,
      source: 'security_flag',
      sourceId: String(flag.id),
      detailsJson: JSON.stringify({ flag_id: flag.id, original_type: flag.type })
    });
  }
}

/**
 * Haversine formula to compute distance in km between two GPS coordinates.
 */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Analyzes a user event (e.g. login or requests) to identify potential takeover/abuse threats.
 */
async function analyzeUserThreats(userId, currentIp, deviceFingerprint, isLoginEvent = false) {
  if (!userId) return;

  try {
    const currentIntel = await checkIpReputation(currentIp);

    // ─── 1. VPN / PROXY / DATACENTER IP CHECK ───
    if (currentIntel && (currentIntel.is_vpn || currentIntel.is_proxy || currentIntel.is_datacenter)) {
      const typeStr = currentIntel.is_vpn ? 'VPN' : (currentIntel.is_proxy ? 'Proxy' : 'Datacenter');
      await createIncident({
        title: `Suspicious Connection via ${typeStr}`,
        description: `User connected from flagged ${typeStr} IP address: ${currentIp}`,
        severity: 'MEDIUM',
        userId,
        ipAddress: currentIp,
        deviceFingerprint,
        source: 'takeover',
        detailsJson: JSON.stringify({
          ip: currentIp,
          is_vpn: currentIntel.is_vpn,
          is_proxy: currentIntel.is_proxy,
          is_datacenter: currentIntel.is_datacenter,
          score: currentIntel.score,
          asn: currentIntel.asn
        })
      });
    }

    // ─── 2. IMPOSSIBLE TRAVEL DETECTION ───
    // Find the last login/activity location for this user
    const lastEvent = await dbGet(`
      SELECT ip_address, timestamp FROM user_activity
      WHERE user_id = ? AND ip_address IS NOT NULL AND ip_address != ?
      ORDER BY timestamp DESC LIMIT 1
    `, [userId, currentIp]);

    if (lastEvent && currentIntel && currentIntel.latitude && currentIntel.longitude) {
      const lastIntel = await checkIpReputation(lastEvent.ip_address);
      if (lastIntel && lastIntel.latitude && lastIntel.longitude) {
        const distanceKm = haversineDistance(
          lastIntel.latitude, lastIntel.longitude,
          currentIntel.latitude, currentIntel.longitude
        );

        const lastTime = new Date(lastEvent.timestamp).getTime();
        const currentTime = Date.now();
        const timeDiffHrs = (currentTime - lastTime) / (1000 * 60 * 60);

        if (timeDiffHrs > 0 && timeDiffHrs < 24) {
          const speedKmh = distanceKm / timeDiffHrs;
          // Trigger if speed exceeds typical flight speeds (> 1000 km/h)
          if (speedKmh > 1000 && distanceKm > 50) {
            await createIncident({
              title: 'Impossible Travel Detected',
              description: `User connected from ${currentIntel.city}, ${currentIntel.country} (${currentIp}) and ${lastIntel.city}, ${lastIntel.country} (${lastEvent.ip_address}) within ${timeDiffHrs.toFixed(2)} hours. Calculated travel speed: ${speedKmh.toFixed(0)} km/h.`,
              severity: 'HIGH',
              userId,
              ipAddress: currentIp,
              deviceFingerprint,
              source: 'impossible_travel',
              detailsJson: JSON.stringify({
                from_ip: lastEvent.ip_address,
                from_location: `${lastIntel.city}, ${lastIntel.country}`,
                to_ip: currentIp,
                to_location: `${currentIntel.city}, ${currentIntel.country}`,
                distance_km: distanceKm,
                time_diff_hours: timeDiffHrs,
                speed_kmh: speedKmh
              })
            });
          }
        }
      }
    }

    // ─── 3. MULTIPLE ACCOUNTS DETECTION ───
    if (deviceFingerprint) {
      // Find distinct user IDs associated with this device fingerprint in user_activity (logins) in the last 24 hours
      const usersOnFingerprint = await dbAll(`
        SELECT DISTINCT user_id FROM user_activity
        WHERE activity_type = 'LOGIN'
          AND timestamp > datetime('now', '-24 hours')
          AND user_id IS NOT NULL
          AND json_extract(metadata_json, '$.device_fingerprint') = ?
      `, [deviceFingerprint]);

      const userIds = usersOnFingerprint.map(u => u.user_id);

      // If our current user is not in the query (which might be the case if this runs just before logging the activity), add them
      if (!userIds.includes(userId)) {
        userIds.push(userId);
      }

      if (userIds.length > 3) {
        await createIncident({
          title: 'Multiple Accounts on Single Device',
          description: `Device fingerprint ${deviceFingerprint} is shared by ${userIds.length} distinct user accounts within 24 hours.`,
          severity: 'MEDIUM',
          userId,
          ipAddress: currentIp,
          deviceFingerprint,
          source: 'multiple_accounts',
          detailsJson: JSON.stringify({
            shared_user_ids: userIds,
            device_fingerprint: deviceFingerprint
          })
        });
      }
    }

    // ─── 4. ACCOUNT TAKEOVER INDICATORS ───
    if (isLoginEvent) {
      // A. Login from a country not visited by the user in the last 30 days
      if (currentIntel && currentIntel.country) {
        const pastCountries = await dbAll(`
          SELECT DISTINCT json_extract(metadata_json, '$.country') AS country
          FROM user_activity
          WHERE user_id = ? AND activity_type = 'LOGIN' AND timestamp > datetime('now', '-30 days')
        `, [userId]);

        const countriesList = pastCountries
          .map(c => c.country)
          .filter(Boolean);

        // Check if user has login history, and this country is entirely new
        if (countriesList.length > 0 && !countriesList.includes(currentIntel.country)) {
          await createIncident({
            title: 'Suspicious Login Location',
            description: `User logged in from country: ${currentIntel.country} (City: ${currentIntel.city}), which is outside their normal locations in the last 30 days: [${countriesList.join(', ')}].`,
            severity: 'HIGH',
            userId,
            ipAddress: currentIp,
            deviceFingerprint,
            source: 'takeover',
            detailsJson: JSON.stringify({
              new_country: currentIntel.country,
              past_countries: countriesList,
              ip: currentIp
            })
          });
        }
      }

      // B. Login from new IP after a password change (within last 2 hours)
      // Check if user activity logs show password change in the last 2 hours from a different IP
      const recentPassChange = await dbGet(`
        SELECT ip_address, timestamp FROM user_activity
        WHERE user_id = ?
          AND (activity_type = 'SETTINGS_CHANGED' OR activity_type = 'PASSWORD_CHANGED')
          AND timestamp > datetime('now', '-2 hours')
          AND ip_address != ?
        ORDER BY timestamp DESC LIMIT 1
      `, [userId, currentIp]);

      if (recentPassChange) {
        await createIncident({
          title: 'Login from New IP After Password Change',
          description: `Login detected from IP ${currentIp} within 2 hours of a password/settings update that originated from IP ${recentPassChange.ip_address}.`,
          severity: 'CRITICAL',
          userId,
          ipAddress: currentIp,
          deviceFingerprint,
          source: 'takeover',
          detailsJson: JSON.stringify({
            login_ip: currentIp,
            settings_updated_from_ip: recentPassChange.ip_address,
            updated_at: recentPassChange.timestamp
          })
        });
      }
    }

  } catch (err) {
    console.error(`[THREAT ENGINE] Error analyzing threats for user ${userId}:`, err.stack || err.message);
  }
}

/**
 * Scans recent logs (security_flags, audit_logs, user_activity) and escalates them to security incidents.
 */
async function scanLogsForIncidents() {
  try {
    // 1. Escalate any un-escalated security flags
    const unescalatedFlags = await dbAll(`
      SELECT f.* FROM security_flags f
      LEFT JOIN security_incidents i ON i.source = 'security_flag' AND i.source_id = CAST(f.id AS TEXT)
      WHERE f.severity IN ('HIGH', 'CRITICAL') AND i.id IS NULL
    `);
    for (const flag of unescalatedFlags) {
      await escalateSecurityFlag(flag);
    }

    // 2. Scan audit logs for any suspicious actions, e.g., privilege updates or role changes
    const suspiciousAuditLogs = await dbAll(`
      SELECT a.* FROM audit_logs a
      LEFT JOIN security_incidents i ON i.source = 'audit_log' AND i.source_id = CAST(a.id AS TEXT)
      WHERE a.action IN ('OWNER_TRANSFERRED', 'USER_ROLE_CHANGED') AND i.id IS NULL
    `);
    for (const log of suspiciousAuditLogs) {
      await createIncident({
        title: `Privilege Change Detected: ${log.action}`,
        description: `Audit log record shows role change. Old Value: ${log.old_value}, New Value: ${log.new_value}`,
        severity: 'HIGH',
        userId: log.target_id,
        source: 'audit_log',
        sourceId: String(log.id),
        detailsJson: JSON.stringify(log)
      });
    }

    // 3. Scan user activity for un-escalated alerts
    const suspiciousActivities = await dbAll(`
      SELECT u.* FROM user_activity u
      LEFT JOIN security_incidents i ON i.source = 'user_activity' AND i.source_id = CAST(u.id AS TEXT)
      WHERE u.activity_type IN ('ACCOUNT_DELETED') AND i.id IS NULL
    `);
    for (const act of suspiciousActivities) {
      await createIncident({
        title: `Critical User Activity: ${act.activity_type}`,
        description: `User ${act.user_email} triggered account deletion.`,
        severity: 'MEDIUM',
        userId: act.user_id,
        ipAddress: act.ip_address,
        source: 'user_activity',
        sourceId: String(act.id),
        detailsJson: JSON.stringify(act)
      });
    }
  } catch (err) {
    console.error('[THREAT ENGINE] Error scanning logs for incidents:', err.message);
  }
}

module.exports = {
  getDeviceFingerprint,
  checkIpReputation,
  createIncident,
  escalateSecurityFlag,
  analyzeUserThreats,
  scanLogsForIncidents
};
