const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { detectLanguageFromFilename } = require('./languages');

const PROJECT_META_FILENAME = 'project_meta.json';
const {
  ensureUserStorage,
  migrateLegacyUserStorage,
  readJsonFileSafeSync,
  writeJsonFileSafe
} = require('./userStorage');

const RUNNABLE_EXTENSIONS = new Set([
  '.py', '.js', '.ts', '.java', '.go', '.rs', '.cpp', '.c', '.rb', '.php'
]);

function createProjectError(status, message, code = 'INVALID_REQUEST') {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function normalizeUserId(userId) {
  const parsed = Number(userId);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw createProjectError(400, 'Invalid user', 'INVALID_USER');
  }
  return parsed;
}

function validatePathSegment(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw createProjectError(400, `${label} is required`, 'INVALID_PATH');
  }

  const trimmed = value.trim();
  if (label === 'programName') {
    if (
      path.isAbsolute(trimmed) ||
      trimmed.includes('/') ||
      trimmed.includes('\\') ||
      trimmed.includes('\0') ||
      trimmed === '.' ||
      trimmed === '..'
    ) {
      throw createProjectError(400, `Invalid ${label}`, 'INVALID_PATH');
    }
  } else {
    // For fileName, allow slashes but reject path traversal (.. and .)
    const segments = trimmed.split(/[/\\]/);
    const hasPathTraversal = segments.some(s => s === '..' || s === '.');
    if (
      path.isAbsolute(trimmed) ||
      trimmed.includes('\0') ||
      hasPathTraversal
    ) {
      throw createProjectError(400, `Invalid ${label}`, 'INVALID_PATH');
    }
  }

  return trimmed;
}

async function getUserGeneratedRoot(userId) {
  const { programsRoot } = await migrateLegacyUserStorage(userId);
  return programsRoot;
}

async function getLastProgramPath(userId) {
  const { lastProgramPath } = await migrateLegacyUserStorage(userId);
  return lastProgramPath;
}

async function resolveWithinUserGenerated(userId, ...segments) {
  const root = await getUserGeneratedRoot(userId);
  const target = path.resolve(root, ...segments);

  if (target !== root && !target.startsWith(root + path.sep)) {
    throw createProjectError(400, 'Invalid path', 'INVALID_PATH');
  }

  return target;
}

function getRunnableFiles(files = []) {
  return files.filter((file) => RUNNABLE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

async function safeStat(targetPath) {
  try {
    return await fsp.stat(targetPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getLastProgram(userId) {
  const lastProgramPath = await getLastProgramPath(userId);
  return readJsonFileSafeSync(lastProgramPath);
}

async function saveLastProgram(data, userId) {
  const normalizedUserId = normalizeUserId(userId);
  const storagePaths = await ensureUserStorage(normalizedUserId);
  const normalizedData = {
    ...data,
    path: data?.program_name && data?.filename
      ? path.join(storagePaths.programsRoot, data.program_name, data.filename)
      : data?.path || null
  };
  await writeJsonFileSafe(storagePaths.lastProgramPath, normalizedData);
}

async function clearLastProgram(userId) {
  const lastProgramPath = await getLastProgramPath(userId);
  try {
    await fsp.unlink(lastProgramPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

async function ensureUserProgramDir(userId, programName) {
  const safeProgramName = validatePathSegment(programName, 'programName');
  const { programsRoot } = await ensureUserStorage(userId);
  const programDir = path.join(programsRoot, safeProgramName);
  await fsp.mkdir(programDir, { recursive: true });
  return { programName: safeProgramName, programDir };
}

async function getSafeProgramDir(userId, programName) {
  const safeProgramName = validatePathSegment(programName, 'programName');
  const programDir = await resolveWithinUserGenerated(userId, safeProgramName);
  const stat = await safeStat(programDir);

  if (!stat || !stat.isDirectory()) {
    throw createProjectError(404, `Program "${safeProgramName}" not found`, 'PROGRAM_NOT_FOUND');
  }

  return { programName: safeProgramName, programDir };
}

async function getSafeProgramFile(userId, programName, fileName) {
  const { programName: safeProgramName, programDir } = await getSafeProgramDir(userId, programName);
  const safeFileName = validatePathSegment(fileName, 'fileName');
  if (safeFileName === 'sitecustomize.py') {
    throw createProjectError(404, `File "${safeFileName}" not found`, 'FILE_NOT_FOUND');
  }
  const filePath = await resolveWithinUserGenerated(userId, safeProgramName, safeFileName);
  const stat = await safeStat(filePath);

  if (!stat) {
    throw createProjectError(404, `File "${safeFileName}" not found`, 'FILE_NOT_FOUND');
  }

  return { programName: safeProgramName, fileName: safeFileName, programDir, filePath };
}

async function syncLastProgramAfterDeletion(userId, programName, deletedFileName = null) {
  const last = await getLastProgram(userId);
  if (!last || last.program_name !== programName) return;

  if (!deletedFileName) {
    await clearLastProgram(userId);
    return;
  }

  if (last.filename !== deletedFileName) return;

  const programDir = await resolveWithinUserGenerated(userId, programName);
  const stat = await safeStat(programDir);
  if (!stat || !stat.isDirectory()) {
    await clearLastProgram(userId);
    return;
  }

  const files = await fsp.readdir(programDir);
  const replacement = getRunnableFiles(files)[0];
  if (!replacement) {
    await clearLastProgram(userId);
    return;
  }

  await saveLastProgram({
    ...last,
    filename: replacement,
    language: detectLanguageFromFilename(replacement),
    timestamp: new Date().toISOString()
  }, userId);
}

async function resolveProgramAndFile(userId, program_name, filename) {
  if (!program_name && !filename) {
    const last = await getLastProgram(userId);
    if (!last) {
      throw createProjectError(404, 'No program found. Generate one first.', 'PROGRAM_NOT_FOUND');
    }
    program_name = last.program_name;
    filename = last.filename;
  }

  const { programName, programDir } = await getSafeProgramDir(userId, program_name || '');

  if (!filename) {
    const files = await fsp.readdir(programDir);
    const runnableFiles = getRunnableFiles(files.filter(f => f !== 'sitecustomize.py'));
    if (!runnableFiles.length) {
      throw createProjectError(404, `No code files found in program "${programName}"`, 'FILE_NOT_FOUND');
    }
    return { program_name: programName, filename: runnableFiles[0] };
  }

  const { fileName } = await getSafeProgramFile(userId, programName, filename);
  return { program_name: programName, filename: fileName };
}

async function listPrograms(userId) {
  const userRoot = await getUserGeneratedRoot(userId);
  if (!fs.existsSync(userRoot)) return [];

  return fs.readdirSync(userRoot)
    .filter((entry) => fs.statSync(path.join(userRoot, entry)).isDirectory())
    .map((name) => {
      const files = fs.readdirSync(path.join(userRoot, name)).filter(f => f !== 'sitecustomize.py');
      const primaryFile = getRunnableFiles(files)[0] || files[0] || null;
      return {
        program_name: name,
        files,
        language: primaryFile ? detectLanguageFromFilename(primaryFile) : null
      };
    });
}

async function deleteProgram(userId, programName) {
  const { programName: safeProgramName, programDir } = await getSafeProgramDir(userId, programName);
  await fsp.rm(programDir, { recursive: true, force: false });
  await syncLastProgramAfterDeletion(userId, safeProgramName);
  return { program_name: safeProgramName };
}

async function deleteProgramFile(userId, programName, fileName) {
  const { programName: safeProgramName, fileName: safeFileName, filePath } = await getSafeProgramFile(userId, programName, fileName);
  const stat = await fsp.stat(filePath).catch(() => null);
  if (stat && stat.isDirectory()) {
    await fsp.rm(filePath, { recursive: true, force: true });
  } else {
    await fsp.unlink(filePath);
  }
  await syncLastProgramAfterDeletion(userId, safeProgramName, safeFileName);
  return { program_name: safeProgramName, file_name: safeFileName };
}

async function updateProgramFile(userId, programName, fileName, content) {
  if (typeof content !== 'string') {
    throw createProjectError(400, 'content must be a string', 'INVALID_CONTENT');
  }

  const { programName: safeProgramName, fileName: safeFileName, filePath } = await getSafeProgramFile(userId, programName, fileName);
  await fsp.writeFile(filePath, content, 'utf8');
  return { program_name: safeProgramName, file_name: safeFileName };
}

/**
 * Write project_meta.json into the program directory.
 * meta shape: { project_type, entry_file, language, files: [string] }
 */
async function saveProjectMeta(userId, programName, meta) {
  const { programDir } = await getSafeProgramDir(userId, programName);
  const metaPath = path.join(programDir, PROJECT_META_FILENAME);
  await writeJsonFileSafe(metaPath, {
    project_type:        meta.project_type        || 'single_file',
    entry_file:          meta.entry_file          || null,
    language:            meta.language            || null,
    files:               meta.files               || [],
    original_request:    meta.original_request    || null,
    requirements_prompt: meta.requirements_prompt || null,
    updated_at:          new Date().toISOString()
  });
}

/**
 * Read project_meta.json from the program directory.
 * Returns null if the file does not exist.
 */
async function readProjectMeta(userId, programName) {
  try {
    const { programDir } = await getSafeProgramDir(userId, programName);
    const metaPath = path.join(programDir, PROJECT_META_FILENAME);
    const raw = await fsp.readFile(metaPath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'PROGRAM_NOT_FOUND' || err.status === 404) return null;
    throw err;
  }
}

async function getProjectFilesWithContent(userId, programName) {
  try {
    const { programDir } = await getSafeProgramDir(userId, programName);
    const entries = await fsp.readdir(programDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile() && entry.name !== PROJECT_META_FILENAME && !entry.name.startsWith('.')) {
        const filePath = path.join(programDir, entry.name);
        const content = await fsp.readFile(filePath, 'utf8');
        files.push({
          filename: entry.name,
          content
        });
      }
    }
    return files;
  } catch (err) {
    console.error(`[PROJECT MANAGER] Error reading files for ${programName}:`, err);
    return [];
  }
}

module.exports = {
  createProjectError,
  getLastProgram,
  saveLastProgram,
  resolveProgramAndFile,
  listPrograms,
  getSafeProgramDir,
  ensureUserProgramDir,
  getSafeProgramFile,
  getUserGeneratedRoot,
  deleteProgram,
  deleteProgramFile,
  updateProgramFile,
  saveProjectMeta,
  readProjectMeta,
  getProjectFilesWithContent,
  PROJECT_META_FILENAME
};
