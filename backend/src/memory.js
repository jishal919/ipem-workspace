// agent/src/memory.js  (UPDATED — adds userId scoping)
const { dbRun, dbAll, dbGet } = require('./database');
const fs = require('fs');
const { MEM_PATH } = require('./config');

// All functions now accept an optional userId (defaults to 0 for backward compat)

async function getMemory(userId = 0) {
  const rows = await dbAll(
    'SELECT key, value FROM facts WHERE user_id = ?',
    [userId]
  );
  const result = {};
  rows.forEach(row => {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  });
  return result;
}

async function updateMemory(data, userId = 0) {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data: ' + JSON.stringify(data));
  }
  // Strip internal middleware injection
  const { _userId, ...cleanData } = data;
  const effectiveUserId = userId || _userId || 0;

  for (const [key, value] of Object.entries(cleanData)) {
    const stringValue = JSON.stringify(value);
    await dbRun(
      `INSERT INTO facts (key, user_id, value, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key, user_id) DO UPDATE SET
         value = excluded.value,
         updated_at = CURRENT_TIMESTAMP`,
      [key, effectiveUserId, stringValue]
    );
  }
  return await getMemory(effectiveUserId);
}

async function clearStaleSession(userId = 0) {
  await dbRun(
    'DELETE FROM facts WHERE key = ? AND user_id = ?',
    ['active_session', userId]
  );
  console.log('Cleared stale session from database');
}

async function migrateFromJson() {
  if (fs.existsSync(MEM_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(MEM_PATH, 'utf8'));
      // Migrate to userId=0 (legacy/anonymous)
      await updateMemory(data, 0);
      console.log('Migrated data from facts.json to SQLite');
    } catch (err) {
      console.error('Migration failed:', err);
    }
  }
}

module.exports = {
  getMemory,
  updateMemory,
  clearStaleSession,
  migrateFromJson
};