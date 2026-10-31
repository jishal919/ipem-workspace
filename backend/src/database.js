// agent/src/database.js  (UPDATED — adds auth tables while keeping existing ones)
const sqlite3 = require('sqlite3').verbose();
const { DB_PATH } = require('./config');
const path = require('path');
const fs = require('fs');

if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  // ─── EXISTING TABLES (unchanged) ───────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS facts (
    key TEXT,
    user_id INTEGER NOT NULL DEFAULT 0,
    value TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (key, user_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    user_id INTEGER NOT NULL DEFAULT 0,
    role TEXT,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_chat_history_user
    ON chat_history(user_id, session_id)`);

  // ─── AUTH TABLES ───────────────────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password_hash TEXT,
    google_id   TEXT    UNIQUE,
    verified    INTEGER NOT NULL DEFAULT 0,
    role        TEXT    NOT NULL DEFAULT 'user'
                  CHECK(role IN ('owner', 'admin', 'moderator', 'user')),
    status      TEXT    NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active', 'suspended', 'banned', 'disabled')),
    otp_hash    TEXT,
    otp_expiry  DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login  DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id          TEXT PRIMARY KEY,
    applied_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('[DB] Failed to add users.role:', err.message);
    }
  });
  db.run(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`, (err) => {
    if (err && !String(err.message).includes('duplicate column name')) {
      console.error('[DB] Failed to add users.status:', err.message);
    }
  });
  db.run(`UPDATE users SET role = 'user' WHERE role IS NULL OR role = ''`);
  db.run(`UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status)`);
  db.run(`
    INSERT OR IGNORE INTO schema_migrations (id)
    VALUES ('20260618_add_user_role_status')
  `);

  const configuredOwnerEmail = process.env.IPEM_BOOTSTRAP_OWNER_EMAIL;
  if (configuredOwnerEmail) {
    db.run(`
      UPDATE users
      SET role = 'owner', status = 'active'
      WHERE lower(email) = lower(?)
        AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')
    `, [configuredOwnerEmail.trim()]);
  }

  db.run(`
    UPDATE users
    SET role = 'owner', status = 'active'
    WHERE id = (
      SELECT id FROM users
      WHERE verified = 1
      ORDER BY id ASC
      LIMIT 1
    )
      AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner')
  `);

  db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    expires_at  DATETIME NOT NULL,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON user_sessions(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_token
    ON user_sessions(token_hash)`);

  db.run(`CREATE TABLE IF NOT EXISTS rate_limits (
    identifier  TEXT PRIMARY KEY,
    attempts    INTEGER NOT NULL DEFAULT 0,
    locked_until DATETIME,
    last_attempt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // ─── USER-SCOPED PROGRAMS TABLE ────────────────────────────────────────────
  // Tracks which programs belong to which user (filesystem is source of truth)
  db.run(`CREATE TABLE IF NOT EXISTS user_programs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    program_name TEXT    NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, program_name)
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_user
    ON user_programs(user_id)`);

  db.run(`CREATE TABLE IF NOT EXISTS user_storage (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    storage_id   TEXT    NOT NULL UNIQUE,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_user_storage_storage_id
    ON user_storage(storage_id)`);

  // ─── AUDIT LOGS TABLE (PHASE 2) ────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor_user_id INTEGER,
    actor_email   TEXT,
    actor_role    TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    old_value     TEXT,
    new_value     TEXT,
    ip_address    TEXT,
    user_agent    TEXT,
    success       INTEGER DEFAULT 1,
    reason        TEXT,
    metadata_json TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_user_id ON audit_logs(actor_user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_target_type ON audit_logs(target_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_logs_target_id ON audit_logs(target_id)`);

  // ─── API REQUESTS TABLE (PHASE 3) ───────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS api_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id       INTEGER,
    user_email    TEXT,
    user_role     TEXT,
    ip_address    TEXT,
    user_agent    TEXT,
    method        TEXT NOT NULL,
    route         TEXT NOT NULL,
    status_code   INTEGER NOT NULL,
    duration_ms   REAL NOT NULL,
    request_size  INTEGER NOT NULL,
    response_size INTEGER NOT NULL,
    success       INTEGER NOT NULL,
    error_message TEXT,
    metadata_json TEXT
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON api_requests(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_user ON api_requests(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_ip ON api_requests(ip_address)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_route ON api_requests(route)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_requests_status ON api_requests(status_code)`);

  // ─── SECURITY FLAGS TABLE (PHASE 3) ─────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS security_flags (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    type          TEXT NOT NULL,
    severity      TEXT NOT NULL,
    user_id       INTEGER,
    ip_address    TEXT,
    details       TEXT,
    resolved      INTEGER DEFAULT 0
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_flags_timestamp ON security_flags(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_flags_type ON security_flags(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_flags_resolved ON security_flags(resolved)`);

  // ─── USER ACTIVITY TABLE (PHASE 4) ──────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS user_activity (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id       INTEGER,
    user_email    TEXT,
    activity_type TEXT NOT NULL,
    resource_type TEXT,
    resource_id   TEXT,
    resource_name TEXT,
    metadata_json TEXT,
    ip_address    TEXT,
    success       INTEGER NOT NULL DEFAULT 1
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON user_activity(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_activity_user ON user_activity(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_activity_type ON user_activity(activity_type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_activity_resource ON user_activity(resource_type)`);

  // ─── PROGRAMS TABLE (PHASE 5) ──────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS programs (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,
    description        TEXT,
    language           TEXT,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_executed_at   DATETIME,
    execution_count    INTEGER DEFAULT 0,
    success_count      INTEGER DEFAULT 0,
    failure_count      INTEGER DEFAULT 0,
    average_runtime_ms REAL DEFAULT 0,
    storage_size_bytes INTEGER DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled', 'suspended', 'deleted')),
    visibility         TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'public', 'unlisted')),
    deleted_at         DATETIME,
    metadata_json      TEXT DEFAULT '{}'
  )`);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_owner_name_active
    ON programs(owner_user_id, name) WHERE deleted_at IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_owner ON programs(owner_user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_status ON programs(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_visibility ON programs(visibility)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_created_at ON programs(created_at)`);

  // ─── CONVERSATIONS TABLE (PHASE 6) ──────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL,
    title           TEXT,
    message_count   INTEGER DEFAULT 0,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_message_at DATETIME,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'locked', 'deleted')),
    deleted_at      DATETIME,
    metadata_json   TEXT DEFAULT '{}'
  )`);

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_user_session_active
    ON conversations(user_id, session_id) WHERE deleted_at IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_created_at ON conversations(created_at)`);

  // ─── SYSTEM METRICS TABLE (PHASE 7) ─────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS system_metrics (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    metric_name   TEXT NOT NULL,
    metric_value  REAL NOT NULL,
    source        TEXT,
    metadata_json TEXT DEFAULT '{}'
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON system_metrics(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_metrics_name ON system_metrics(metric_name)`);

  // ─── SYSTEM ALERTS TABLE (PHASE 7) ──────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS system_alerts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP,
    severity      TEXT NOT NULL CHECK(severity IN ('CRITICAL', 'WARNING', 'INFO')),
    title         TEXT NOT NULL,
    description   TEXT,
    resolved      INTEGER DEFAULT 0
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON system_alerts(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON system_alerts(resolved)`);

  // ─── LLM REQUESTS TABLE (PHASE 8 & ANALYTICS) ─────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS llm_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp         DATETIME DEFAULT CURRENT_TIMESTAMP,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        TEXT,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    input_tokens      INTEGER DEFAULT 0,
    output_tokens     INTEGER DEFAULT 0,
    total_tokens      INTEGER DEFAULT 0,
    prompt_length     INTEGER DEFAULT 0,
    completion_length INTEGER DEFAULT 0,
    prompt_text       TEXT,
    completion_text   TEXT,
    latency_ms        REAL DEFAULT 0,
    success           INTEGER DEFAULT 1,
    error             TEXT,
    estimated_cost    REAL DEFAULT 0
  )`);

  db.run(`ALTER TABLE llm_requests ADD COLUMN session_id TEXT`, () => {});
  db.run(`ALTER TABLE llm_requests ADD COLUMN prompt_length INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE llm_requests ADD COLUMN completion_length INTEGER DEFAULT 0`, () => {});
  db.run(`ALTER TABLE llm_requests ADD COLUMN prompt_text TEXT`, () => {});
  db.run(`ALTER TABLE llm_requests ADD COLUMN completion_text TEXT`, () => {});

  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_timestamp ON llm_requests(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_user ON llm_requests(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_model ON llm_requests(model)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_session ON llm_requests(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_provider ON llm_requests(provider)`);

  // ─── LLM JOBS TABLE (ASYNC JOB POLLING ENGINE) ────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS llm_jobs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id            TEXT UNIQUE NOT NULL,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id        TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'processing',
    prompt_text       TEXT,
    result_json       TEXT,
    error_text        TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_jobs_job_id ON llm_jobs(job_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_llm_jobs_user_session ON llm_jobs(user_id, session_id)`);

  // ─── IP REPUTATION TABLE (PHASE 9) ──────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS ip_reputation (
    ip             TEXT PRIMARY KEY,
    score          REAL DEFAULT 0.0,
    is_vpn         INTEGER DEFAULT 0,
    is_proxy       INTEGER DEFAULT 0,
    is_datacenter  INTEGER DEFAULT 0,
    country        TEXT,
    city           TEXT,
    latitude       REAL,
    longitude      REAL,
    asn            TEXT,
    last_checked   DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata_json  TEXT DEFAULT '{}'
  )`);

  // ─── BANNED IPS TABLE (PHASE 9) ─────────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS banned_ips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ip             TEXT NOT NULL UNIQUE,
    banned_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at     DATETIME,
    reason         TEXT,
    banned_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_banned_ips_expires ON banned_ips(expires_at)`);

  // ─── BLOCKED DEVICES TABLE (PHASE 9) ────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS blocked_devices (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    device_fingerprint TEXT NOT NULL UNIQUE,
    blocked_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    reason             TEXT,
    blocked_by         INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`);

  // ─── SECURITY INCIDENTS TABLE (PHASE 9) ─────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS security_incidents (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp          DATETIME DEFAULT CURRENT_TIMESTAMP,
    title              TEXT NOT NULL,
    description        TEXT,
    severity           TEXT NOT NULL CHECK(severity IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
    status             TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved', 'dismissed')),
    user_id            INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address         TEXT,
    device_fingerprint TEXT,
    source             TEXT NOT NULL CHECK(source IN ('security_flag', 'audit_log', 'request_log', 'user_activity', 'impossible_travel', 'multiple_accounts', 'takeover', 'manual')),
    source_id          TEXT,
    details_json       TEXT DEFAULT '{}',
    resolved_at        DATETIME,
    resolved_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    resolution_notes   TEXT
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_timestamp ON security_incidents(timestamp)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON security_incidents(status)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_user ON security_incidents(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_ip ON security_incidents(ip_address)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_severity ON security_incidents(severity)`);

  // ─── ADMIN NOTES TABLE (PHASE 10) ───────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS admin_notes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_type    TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    content        TEXT NOT NULL,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_target ON admin_notes(target_type, target_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_user ON admin_notes(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notes_created ON admin_notes(created_at)`);

  // ─── SEARCH OPTIMIZATION INDEXES (PHASE 10) ─────────────────────────────────
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_name_search ON users(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_email_search ON users(email)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_programs_name_search ON programs(name)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_title_search ON conversations(title)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_title_search ON security_incidents(title)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_flags_type_search ON security_flags(type)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_reputation_ip_search ON ip_reputation(ip)`);

  // ─── ADMIN MESSAGE RECEIPTS TABLE ─────────────────────────────────────────
  db.run(`CREATE TABLE IF NOT EXISTS admin_message_receipts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id      INTEGER NOT NULL REFERENCES chat_history(id) ON DELETE CASCADE,
    sender_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'SENT' CHECK(status IN ('SENT', 'DELIVERED', 'READ')),
    sent_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivered_at    DATETIME,
    read_at         DATETIME
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_receipts_user ON admin_message_receipts(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_admin_receipts_message ON admin_message_receipts(message_id)`);

  // ─── CONVERSATION PROJECTS TABLE (ONE CONVERSATION = ONE PROJECT) ────────────
  // Permanently links a conversation session to exactly one project.
  // Once set, the session_id → program_name binding is immutable (only metadata updates).
  db.run(`CREATE TABLE IF NOT EXISTS conversation_projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL,
    program_name    TEXT NOT NULL,
    project_type    TEXT,
    language        TEXT,
    entry_file      TEXT,
    root_directory  TEXT,
    packages        TEXT DEFAULT '[]',
    project_created DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_modified   DATETIME DEFAULT CURRENT_TIMESTAMP,
    project_status  TEXT NOT NULL DEFAULT 'active'
                      CHECK(project_status IN ('active', 'archived', 'deleted')),
    UNIQUE(user_id, session_id)
  )`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conv_projects_user ON conversation_projects(user_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conv_projects_session ON conversation_projects(session_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conv_projects_program ON conversation_projects(program_name)`);
});

// ─── PROMISE WRAPPERS (unchanged) ────────────────────────────────────────────
const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const dbAll = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

module.exports = { db, dbRun, dbAll, dbGet };
