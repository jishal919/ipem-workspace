const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { PROJECTS_PATH, GENERATED_DIR, LAST_PROGRAM_PATH, LOGS_DIR } = require('./config');
const { dbGet, dbRun, dbAll } = require('./database');

const USERS_DIR = path.join(PROJECTS_PATH, 'users');
const STORAGE_ID_MIN = 10000;
const STORAGE_ID_MAX = 999999;
const STORAGE_ID_LENGTH_MIN = 5;
const STORAGE_ID_LENGTH_MAX = 6;

function normalizeUserId(userId) {
  const parsed = Number(userId);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Invalid user id');
  }
  return parsed;
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
  return targetPath;
}

async function appendFileSafe(filePath, content) {
  await ensureDir(path.dirname(filePath));
  await fsp.appendFile(filePath, content, 'utf8');
}

async function writeJsonFileSafe(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function writeJsonFileSafeSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJsonFileSafeSync(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.warn(`Failed to read JSON file ${filePath}:`, err.message);
    return null;
  }
}

function getLegacyGeneratedCandidates(userId) {
  const normalizedUserId = normalizeUserId(userId);
  return [
    path.join(GENERATED_DIR, `user_${normalizedUserId}`),
    path.join(GENERATED_DIR, `user${normalizedUserId}`)
  ];
}

function getLegacyLastProgramCandidates(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (normalizedUserId === 0) {
    return [LAST_PROGRAM_PATH];
  }
  return [
    path.join(path.dirname(LAST_PROGRAM_PATH), `last_program_user_${normalizedUserId}.json`)
  ];
}

function getLegacyGlobalLogsDir() {
  return LOGS_DIR;
}

function randomStorageId() {
  const value = crypto.randomInt(STORAGE_ID_MIN, STORAGE_ID_MAX + 1).toString();
  if (value.length < STORAGE_ID_LENGTH_MIN || value.length > STORAGE_ID_LENGTH_MAX) {
    return randomStorageId();
  }
  return value;
}

async function resolveStoredStorageId(userId) {
  const normalizedUserId = normalizeUserId(userId);
  if (normalizedUserId === 0) {
    return '00000';
  }

  const row = await dbGet(
    'SELECT storage_id FROM user_storage WHERE user_id = ?',
    [normalizedUserId]
  );
  if (row?.storage_id) return row.storage_id;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const storageId = randomStorageId();
    const existingRow = await dbGet(
      'SELECT user_id FROM user_storage WHERE storage_id = ?',
      [storageId]
    );
    if (existingRow) continue;

    const existingDir = await pathExists(path.join(USERS_DIR, storageId));
    if (existingDir) continue;

    try {
      await dbRun(
        'INSERT INTO user_storage (user_id, storage_id, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
        [normalizedUserId, storageId]
      );
      return storageId;
    } catch (err) {
      if (err.code === 'SQLITE_CONSTRAINT') {
        const retryRow = await dbGet(
          'SELECT storage_id FROM user_storage WHERE user_id = ?',
          [normalizedUserId]
        );
        if (retryRow?.storage_id) return retryRow.storage_id;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to allocate unique storage ID for user ${normalizedUserId}`);
}

async function getUserStoragePaths(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const storageId = await resolveStoredStorageId(normalizedUserId);
  const userRoot = path.join(USERS_DIR, storageId);
  const generatedRoot = path.join(userRoot, 'generated');
  const programsRoot = path.join(generatedRoot, 'programs');
  const generatedLogsRoot = path.join(generatedRoot, 'logs');
  const logsRoot = path.join(userRoot, 'logs');

  return {
    userId: normalizedUserId,
    storageId,
    userRoot,
    generatedRoot,
    programsRoot,
    generatedLogsRoot,
    logsRoot,
    chatLogPath: path.join(logsRoot, 'chat.log'),
    lastProgramPath: path.join(userRoot, 'lastprogram.json'),
    migrationMarkerPath: path.join(userRoot, '.migration-complete')
  };
}

async function ensureUserStorage(userId) {
  const paths = await getUserStoragePaths(userId);
  await Promise.all([
    ensureDir(paths.userRoot),
    ensureDir(paths.programsRoot),
    ensureDir(paths.generatedLogsRoot),
    ensureDir(paths.logsRoot)
  ]);
  return paths;
}

async function copyDirectoryContents(sourceDir, targetDir) {
  await ensureDir(targetDir);
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (entry.isFile() && !(await pathExists(targetPath))) {
      await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function migrateLegacyGeneratedData(userId, storagePaths) {
  for (const legacyDir of getLegacyGeneratedCandidates(userId)) {
    if (!(await pathExists(legacyDir))) continue;
    await copyDirectoryContents(legacyDir, storagePaths.programsRoot);
  }
}

async function migrateLegacyLastProgram(userId, storagePaths) {
  if (await pathExists(storagePaths.lastProgramPath)) return;

  for (const candidatePath of getLegacyLastProgramCandidates(userId)) {
    const legacyData = readJsonFileSafeSync(candidatePath);
    if (!legacyData) continue;

    const normalized = { ...legacyData };
    if (normalized.program_name && normalized.filename) {
      normalized.path = path.join(storagePaths.programsRoot, normalized.program_name, normalized.filename);
    }

    await writeJsonFileSafe(storagePaths.lastProgramPath, normalized);
    return;
  }
}

async function migrateLegacyLogs(userId, storagePaths) {
  const globalLogsDir = getLegacyGlobalLogsDir();
  if (!(await pathExists(globalLogsDir))) return;

  const prefixes = [];
  for (const legacyDir of getLegacyGeneratedCandidates(userId)) {
    if (await pathExists(legacyDir)) {
      const programNames = await fsp.readdir(legacyDir);
      prefixes.push(...programNames);
    }
  }

  if (!prefixes.length) return;

  const logEntries = await fsp.readdir(globalLogsDir, { withFileTypes: true });
  for (const entry of logEntries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.log') continue;
    const matchesProgram = prefixes.some((prefix) => entry.name.startsWith(`${prefix}_`));
    if (!matchesProgram) continue;

    const sourcePath = path.join(globalLogsDir, entry.name);
    const targetPath = path.join(storagePaths.generatedLogsRoot, entry.name);
    if (!(await pathExists(targetPath))) {
      await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function migrateLegacyUserStorage(userId) {
  const storagePaths = await ensureUserStorage(userId);
  return storagePaths;
}

async function migrateAllLegacyStorage() {
  await ensureDir(USERS_DIR);

  const rows = await dbAll('SELECT id FROM users');
  const knownUserIds = new Set(rows.map((row) => Number(row.id)));

  const generatedEntries = await pathExists(GENERATED_DIR)
    ? await fsp.readdir(GENERATED_DIR, { withFileTypes: true })
    : [];

  for (const entry of generatedEntries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^user_?(\d+)$/);
    if (!match) continue;
    const userId = Number(match[1]);
    const existingUser = await dbGet('SELECT id FROM users WHERE id = ?', [userId]);
    if (existingUser?.id) {
      knownUserIds.add(userId);
    }
  }

  for (const userId of knownUserIds) {
    try {
      await migrateLegacyUserStorage(userId);
    } catch (err) {
      console.warn(`Failed to migrate storage for user ${userId}:`, err.message);
    }
  }
}

async function appendPromptLog(userId, payload) {
  const storagePaths = await ensureUserStorage(userId);
  const timestamp = new Date().toISOString();
  const prompt = payload.prompt || '';
  const line = `USER [${timestamp}] : ${prompt}\n`;
  await appendFileSafe(storagePaths.chatLogPath || path.join(storagePaths.logsRoot, 'chat.log'), line);
}

async function appendResponseLog(userId, payload) {
  const storagePaths = await ensureUserStorage(userId);
  const timestamp = new Date().toISOString();
  let message = '';
  if (payload.response) {
    if (typeof payload.response === 'string') {
      message = payload.response;
    } else if (typeof payload.response.output === 'string') {
      message = payload.response.output;
    } else {
      message = JSON.stringify(payload.response);
    }
  }
  const line = `IPEM [${timestamp}] : ${message}\n`;
  await appendFileSafe(storagePaths.chatLogPath || path.join(storagePaths.logsRoot, 'chat.log'), line);
}

async function cleanLegacySiteCustomize() {
  try {
    const rows = await dbAll('SELECT id FROM users');
    for (const row of rows) {
      const paths = await getUserStoragePaths(row.id);
      if (fs.existsSync(paths.programsRoot)) {
        const programDirs = await fsp.readdir(paths.programsRoot, { withFileTypes: true });
        for (const entry of programDirs) {
          if (entry.isDirectory()) {
            const siteCustomizeFile = path.join(paths.programsRoot, entry.name, 'sitecustomize.py');
            if (fs.existsSync(siteCustomizeFile)) {
              try {
                await fsp.unlink(siteCustomizeFile);
                console.log(`[CLEANUP] Deleted legacy sitecustomize.py from ${entry.name}`);
              } catch (e) {
                console.warn(`[CLEANUP] Failed to delete legacy sitecustomize.py in ${siteCustomizeFile}:`, e.message);
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[CLEANUP] Error during legacy sitecustomize.py cleanup:', err);
  }
}

async function deleteUserCompletely(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const { dbRun } = require('./database');

  // 1. Get storage paths to delete files/directories
  try {
    const paths = await getUserStoragePaths(normalizedUserId);
    if (paths && paths.userRoot) {
      const fsp = require('fs/promises');
      await fsp.rm(paths.userRoot, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.warn(`Failed to clean user storage directories for ${normalizedUserId}:`, err.message);
  }

  // 2. Clean up legacy candidates
  try {
    const fsp = require('fs/promises');
    for (const legacyDir of getLegacyGeneratedCandidates(normalizedUserId)) {
      await fsp.rm(legacyDir, { recursive: true, force: true }).catch(() => {});
    }
    for (const candidatePath of getLegacyLastProgramCandidates(normalizedUserId)) {
      await fsp.rm(candidatePath, { force: true }).catch(() => {});
    }
  } catch (err) {
    console.warn(`Failed to clean legacy storage for user ${normalizedUserId}:`, err.message);
  }

  // 3. Delete in database (dependency order)
  await dbRun('DELETE FROM user_sessions  WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM chat_history   WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM conversations  WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM facts          WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM user_programs  WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM programs       WHERE owner_user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM rate_limits    WHERE identifier LIKE ?', [`%${normalizedUserId}%`]);
  await dbRun('DELETE FROM llm_requests   WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM user_storage   WHERE user_id = ?', [normalizedUserId]);
  await dbRun('DELETE FROM users          WHERE id = ?',      [normalizedUserId]);
}

module.exports = {
  USERS_DIR,
  ensureDir,
  appendFileSafe,
  writeJsonFileSafe,
  writeJsonFileSafeSync,
  readJsonFileSafeSync,
  getUserStoragePaths,
  ensureUserStorage,
  migrateLegacyUserStorage,
  migrateAllLegacyStorage,
  appendPromptLog,
  appendResponseLog,
  deleteUserCompletely,
  cleanLegacySiteCustomize
};
