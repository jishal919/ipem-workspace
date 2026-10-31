const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { dbAll, dbRun, dbGet } = require('./database');
const { getUserStoragePaths } = require('./userStorage');
const { detectLanguageFromFilename } = require('./languages');

const RUNNABLE_EXTENSIONS = new Set([
  '.py', '.js', '.ts', '.java', '.go', '.rs', '.cpp', '.c', '.rb', '.php'
]);

async function getFolderMetadata(dirPath) {
  let totalSize = 0;
  let primaryFile = null;

  async function walk(currentPath) {
    const entries = await fsp.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (['venv', 'node_modules', '.git', '__pycache__'].includes(entry.name)) {
          continue;
        }
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name === 'sitecustomize.py') {
          continue;
        }
        const stat = await fsp.stat(fullPath);
        totalSize += stat.size;

        const ext = path.extname(entry.name).toLowerCase();
        if (RUNNABLE_EXTENSIONS.has(ext)) {
          if (!primaryFile) {
            primaryFile = entry.name;
          } else {
            const baseLower = entry.name.toLowerCase();
            if (baseLower.startsWith('main.') || baseLower.startsWith('index.')) {
              primaryFile = entry.name;
            }
          }
        } else if (!primaryFile) {
          primaryFile = entry.name;
        }
      }
    }
  }

  try {
    await walk(dirPath);
  } catch (err) {
    console.error(`[PROGRAM SERVICE] Error walking ${dirPath}:`, err.message);
  }

  return {
    sizeBytes: totalSize,
    primaryFile,
    language: primaryFile ? detectLanguageFromFilename(primaryFile) : null
  };
}

async function syncPrograms() {
  console.log('[PROGRAM SERVICE] Starting program synchronization...');
  try {
    const users = await dbAll('SELECT id FROM users');

    for (const user of users) {
      const paths = await getUserStoragePaths(user.id);
      const rootExists = fs.existsSync(paths.programsRoot);
      if (!rootExists) continue;

      const entries = await fsp.readdir(paths.programsRoot, { withFileTypes: true });
      const folders = entries.filter(e => e.isDirectory()).map(e => e.name);
      const diskPrograms = new Set(folders);

      for (const folderName of folders) {
        const dirPath = path.join(paths.programsRoot, folderName);
        const meta = await getFolderMetadata(dirPath);

        const stat = await fsp.stat(dirPath);
        const folderCreatedAt = stat.birthtime.toISOString();
        const folderUpdatedAt = stat.mtime.toISOString();

        const existing = await dbGet(
          'SELECT id, storage_size_bytes, language FROM programs WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL',
          [user.id, folderName]
        );

        if (!existing) {
          await dbRun(`
            INSERT INTO programs (
              owner_user_id, name, language, storage_size_bytes, status, visibility, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'active', 'private', ?, ?)
          `, [user.id, folderName, meta.language, meta.sizeBytes, folderCreatedAt, folderUpdatedAt]);
          console.log(`[PROGRAM SERVICE] Registered new program: user=${user.id}, name=${folderName}`);
        } else {
          if (existing.storage_size_bytes !== meta.sizeBytes || existing.language !== meta.language) {
            await dbRun(
              'UPDATE programs SET language = ?, storage_size_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              [meta.language, meta.sizeBytes, existing.id]
            );
          }
        }
      }

      const dbActive = await dbAll(
        'SELECT name FROM programs WHERE owner_user_id = ? AND deleted_at IS NULL',
        [user.id]
      );

      for (const dbProg of dbActive) {
        if (!diskPrograms.has(dbProg.name)) {
          await dbRun(
            "UPDATE programs SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL",
            [user.id, dbProg.name]
          );
          console.log(`[PROGRAM SERVICE] Soft-deleted missing program: user=${user.id}, name=${dbProg.name}`);
        }
      }
    }
    console.log('[PROGRAM SERVICE] Program synchronization complete.');
  } catch (err) {
    console.error('[PROGRAM SERVICE] syncPrograms error:', err);
  }
}

async function findAndSyncSingleProgram(userId, programName) {
  try {
    const paths = await getUserStoragePaths(userId);
    const dirPath = path.join(paths.programsRoot, programName);
    const exists = fs.existsSync(dirPath);

    if (!exists) {
      await dbRun(
        "UPDATE programs SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL",
        [userId, programName]
      );
      return null;
    }

    const meta = await getFolderMetadata(dirPath);
    const stat = await fsp.stat(dirPath);
    const folderCreatedAt = stat.birthtime.toISOString();
    const folderUpdatedAt = stat.mtime.toISOString();

    const existing = await dbGet(
      'SELECT * FROM programs WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL',
      [userId, programName]
    );

    if (!existing) {
      await dbRun(`
        INSERT INTO programs (
          owner_user_id, name, language, storage_size_bytes, status, visibility, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'active', 'private', ?, ?)
      `, [userId, programName, meta.language, meta.sizeBytes, folderCreatedAt, folderUpdatedAt]);

      return await dbGet(
        'SELECT * FROM programs WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL',
        [userId, programName]
      );
    } else {
      await dbRun(
        'UPDATE programs SET language = ?, storage_size_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [meta.language, meta.sizeBytes, existing.id]
      );
      existing.language = meta.language;
      existing.storage_size_bytes = meta.sizeBytes;
      return existing;
    }
  } catch (err) {
    console.error('[PROGRAM SERVICE] findAndSyncSingleProgram error:', err);
    return null;
  }
}

async function updateProgramExecutionStats(userId, programName, isSuccess, durationMs) {
  try {
    const successInc = isSuccess ? 1 : 0;
    const failureInc = isSuccess ? 0 : 1;

    await dbRun(`
      UPDATE programs
      SET
        execution_count = execution_count + 1,
        success_count = success_count + ?,
        failure_count = failure_count + ?,
        last_executed_at = CURRENT_TIMESTAMP,
        average_runtime_ms = CASE
          WHEN execution_count = 0 THEN ?
          ELSE ((average_runtime_ms * execution_count) + ?) / (execution_count + 1)
        END
      WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL
    `, [successInc, failureInc, durationMs, durationMs, userId, programName]);
  } catch (err) {
    console.error('[PROGRAM SERVICE] updateProgramExecutionStats error:', err);
  }
}

async function checkExecutionBlocked(userId, programName) {
  const row = await dbGet(
    'SELECT status, metadata_json FROM programs WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL',
    [userId, programName]
  );
  if (!row) {
    const synced = await findAndSyncSingleProgram(userId, programName);
    if (!synced) {
      return { blocked: true, reason: 'Program not found' };
    }
    return { blocked: false };
  }

  if (row.status !== 'active') {
    return { blocked: true, reason: `Program status is '${row.status}' (must be active to execute)` };
  }

  let meta = {};
  try {
    meta = JSON.parse(row.metadata_json || '{}');
  } catch (_) {}

  if (meta.locked) {
    return { blocked: true, reason: 'Program execution is locked by administrator' };
  }

  return { blocked: false };
}

module.exports = {
  syncPrograms,
  findAndSyncSingleProgram,
  updateProgramExecutionStats,
  checkExecutionBlocked
};
