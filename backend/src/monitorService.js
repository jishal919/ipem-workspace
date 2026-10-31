const os = require('os');
const { exec } = require('child_process');
const { dbRun, dbGet, dbAll } = require('./database');
const { redis } = require('./sessionManager');
const axios = require('axios');

let daemonInterval = null;

function getCpuAverage() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
  for (const cpu of cpus) {
    user += cpu.times.user;
    nice += cpu.times.nice;
    sys += cpu.times.sys;
    idle += cpu.times.idle;
    irq += cpu.times.irq;
  }
  const total = user + nice + sys + idle + irq;
  return { idle, total };
}

function getCpuUsage(ms = 200) {
  return new Promise((resolve) => {
    const start = getCpuAverage();
    setTimeout(() => {
      const end = getCpuAverage();
      const idleDiff = end.idle - start.idle;
      const totalDiff = end.total - start.total;
      if (totalDiff === 0) resolve(0);
      else resolve(Math.round((100 - (100 * idleDiff / totalDiff)) * 100) / 100);
    }, ms);
  });
}

function getMemoryUsage() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    total,
    free,
    used,
    percent: Math.round((used / total) * 10000) / 100
  };
}

function getDiskUsage() {
  return new Promise((resolve) => {
    exec('powershell -Command "Get-Volume -DriveLetter C | Select-Object SizeRemaining, Size | ConvertTo-Json"', (err, stdout) => {
      if (err || !stdout) {
        resolve({ percent: 50 }); // fallback
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const free = data.SizeRemaining || 0;
        const total = data.Size || 0;
        if (total === 0) {
          resolve({ percent: 0 });
        } else {
          resolve({
            total,
            free,
            used: total - free,
            percent: Math.round(((total - free) / total) * 10000) / 100
          });
        }
      } catch (_) {
        resolve({ percent: 50 });
      }
    });
  });
}

function getNetstatBytes() {
  return new Promise((resolve) => {
    exec('netstat -e', (err, stdout) => {
      if (err || !stdout) {
        resolve({ rx: 0, tx: 0 });
        return;
      }
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (/^\s*Bytes/i.test(line)) {
          const parts = line.trim().split(/\s+/);
          const rx = parseInt(parts[1], 10) || 0;
          const tx = parseInt(parts[2], 10) || 0;
          resolve({ rx, tx });
          return;
        }
      }
      resolve({ rx: 0, tx: 0 });
    });
  });
}

async function getDatabaseHealth() {
  try {
    const start = Date.now();
    await dbGet('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function getRedisHealth() {
  try {
    const start = Date.now();
    if (!redis) {
      return { ok: false, error: 'Redis client not initialized' };
    }
    const pongPromise = redis.ping();
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Redis ping timeout')), 1500));
    await Promise.race([pongPromise, timeoutPromise]);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function checkUrlHealth(url, label) {
  try {
    const start = Date.now();
    await axios.get(url, { timeout: 2000, validateStatus: () => true });
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleAlertTrigger(title, severity, description, isTriggered) {
  try {
    const existing = await dbGet('SELECT id FROM system_alerts WHERE title = ? AND resolved = 0', [title]);

    if (isTriggered) {
      if (!existing) {
        await dbRun(`
          INSERT INTO system_alerts (severity, title, description, resolved)
          VALUES (?, ?, ?, 0)
        `, [severity, title, description]);
        console.warn(`[MONITOR ALERT] Raised alert: ${title} (${severity}) - ${description}`);
      }
    } else {
      if (existing) {
        await dbRun('UPDATE system_alerts SET resolved = 1 WHERE id = ?', [existing.id]);
        console.log(`[MONITOR ALERT] Auto-resolved alert: ${title}`);

        const { auditLog } = require('./auditLogger');
        await auditLog({
          action: 'ALERT_AUTO_RESOLVED',
          actorId: 0,
          actorEmail: 'system@ipem.com',
          actorRole: 'system',
          targetType: 'alert',
          targetId: title,
          newValue: 'resolved',
          reason: 'System health restored'
        });
      }
    }
  } catch (err) {
    console.error(`[MONITOR SERVICE] handleAlertTrigger error for ${title}:`, err.message);
  }
}

async function collectAllMetrics() {
  const tStart = Date.now();
  const netStart = await getNetstatBytes();
  const cpu = await getCpuUsage(200);
  const netEnd = await getNetstatBytes();
  const tEnd = Date.now();

  const elapsedSeconds = (tEnd - tStart) / 1000;
  const rxSpeed = Math.max(0, Math.round((netEnd.rx - netStart.rx) / elapsedSeconds));
  const txSpeed = Math.max(0, Math.round((netEnd.tx - netStart.tx) / elapsedSeconds));

  const mem = getMemoryUsage();
  const disk = await getDiskUsage();
  const db = await getDatabaseHealth();
  const redisHealth = await getRedisHealth();

  const litellmUrl = process.env.LITELLM_BASE_URL || 'http://localhost:4000';
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const n8nUrl = process.env.N8N_HEALTH_URL || 'http://localhost:5678/webhook/health';
  const googleOauthUrl = 'https://accounts.google.com/.well-known/openid-configuration';

  const litellm = await checkUrlHealth(`${litellmUrl}/health/liveness`, 'LiteLLM');
  const ollama = await checkUrlHealth(ollamaUrl, 'Ollama');
  const n8n = await checkUrlHealth(n8nUrl, 'n8n');
  const google = await checkUrlHealth(googleOauthUrl, 'Google OAuth');

  const timestamp = new Date().toISOString();

  const metricsToStore = [
    { name: 'cpu_usage_percent', val: cpu, source: 'os' },
    { name: 'memory_usage_percent', val: mem.percent, source: 'os', meta: { used: mem.used, total: mem.total } },
    { name: 'disk_usage_percent', val: disk.percent, source: 'os', meta: { used: disk.used, total: disk.total } },
    { name: 'database_latency_ms', val: db.ok ? db.latencyMs : -1, source: 'sqlite', meta: { ok: db.ok, error: db.error } },
    { name: 'redis_latency_ms', val: redisHealth.ok ? redisHealth.latencyMs : -1, source: 'redis', meta: { ok: redisHealth.ok, error: redisHealth.error } },
    { name: 'litellm_latency_ms', val: litellm.ok ? litellm.latencyMs : -1, source: 'litellm', meta: { ok: litellm.ok, error: litellm.error } },
    { name: 'ollama_latency_ms', val: ollama.ok ? ollama.latencyMs : -1, source: 'ollama', meta: { ok: ollama.ok, error: ollama.error } },
    { name: 'n8n_latency_ms', val: n8n.ok ? n8n.latencyMs : -1, source: 'n8n', meta: { ok: n8n.ok, error: n8n.error } },
    { name: 'google_oauth_latency_ms', val: google.ok ? google.latencyMs : -1, source: 'google', meta: { ok: google.ok, error: google.error } }
  ];

  for (const m of metricsToStore) {
    try {
      await dbRun(`
        INSERT INTO system_metrics (metric_name, metric_value, source, metadata_json, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `, [m.name, m.val, m.source, JSON.stringify(m.meta || {}), timestamp]);
    } catch (err) {
      console.error(`[MONITOR SERVICE] Failed to insert metric ${m.name}:`, err.message);
    }
  }

  await handleAlertTrigger('High CPU Usage', 'CRITICAL', `CPU usage is at ${cpu}%`, cpu > 90);
  await handleAlertTrigger('High Memory Usage', 'CRITICAL', `Memory usage is at ${mem.percent}%`, mem.percent > 90);
  await handleAlertTrigger('High Disk Usage', 'CRITICAL', `Disk usage is at ${disk.percent}%`, disk.percent > 90);
  await handleAlertTrigger('Database Unavailable', 'CRITICAL', `SQLite database returned connection error: ${db.error || 'Unknown'}`, !db.ok);
  await handleAlertTrigger('Redis Unavailable', 'CRITICAL', `Redis cache returned connection error: ${redisHealth.error || 'Unknown'}`, !redisHealth.ok);

  const llmOffline = !litellm.ok && !ollama.ok;
  await handleAlertTrigger('LLM Service Offline', 'CRITICAL', 'Both LiteLLM and Ollama services are offline', llmOffline);

  await handleAlertTrigger('n8n Webhook Unavailable', 'WARNING', `n8n webhook check failed: ${n8n.error || 'Unknown'}`, !n8n.ok);
  await handleAlertTrigger('Google OAuth Endpoint Offline', 'WARNING', `Google OAuth verification endpoint returned error: ${google.error || 'Unknown'}`, !google.ok);

  return {
    cpu,
    cpuSpeed: os.cpus()[0]?.speed ? (os.cpus()[0].speed / 1000).toFixed(2) : null,
    network: { rxSpeed, txSpeed },
    mem,
    disk,
    db,
    redis: redisHealth,
    litellm,
    ollama,
    n8n,
    google
  };
}

function startMonitoringDaemon() {
  if (daemonInterval) return;
  console.log('[MONITOR SERVICE] Starting system infrastructure monitoring daemon...');

  collectAllMetrics().catch(err => {
    console.error('[MONITOR SERVICE] First metrics collection failed:', err);
  });

  daemonInterval = setInterval(() => {
    collectAllMetrics().catch(err => {
      console.error('[MONITOR SERVICE] Daemon metrics collection failed:', err);
    });
  }, 30000);
}

function stopMonitoringDaemon() {
  if (daemonInterval) {
    clearInterval(daemonInterval);
    daemonInterval = null;
    console.log('[MONITOR SERVICE] Stopped monitoring daemon.');
  }
}

module.exports = {
  startMonitoringDaemon,
  stopMonitoringDaemon,
  collectAllMetrics,
  getDatabaseHealth,
  getRedisHealth,
  getCpuUsage,
  getMemoryUsage,
  getDiskUsage,
  checkUrlHealth
};
