//agent\server.js
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');
const cookieParser = require('cookie-parser');
const { requireAuth, requireActiveStatus, scopeByUser } = require('./src/authMiddleware');
const adminRoutes = require('./src/adminRoutes');
const { auditContextMiddleware } = require('./src/auditMiddleware');
const { requestLoggerMiddleware } = require('./src/requestLogger');
const { securityBanMiddleware } = require('./src/securityMiddleware');
const authRoutes = require('./src/authRoutes');
require('dotenv').config();
const { PORT } = require('./src/config');
const {
  FENCE_MAP,
  detectLanguageFromCode,
  getExtension,
  stripCodeFences,
  getLanguageStatus
} = require('./src/languages');
const {
  getLastProgram,
  saveLastProgram,
  resolveProgramAndFile,
  listPrograms,
  ensureUserProgramDir,
  getSafeProgramFile,
  getSafeProgramDir,
  deleteProgram,
  deleteProgramFile,
  updateProgramFile,
  saveProjectMeta,
  readProjectMeta
} = require('./src/projectManager');
const {
  getMemory,
  updateMemory,
  clearStaleSession,
  migrateFromJson
} = require('./src/memory');
const {
  migrateAllLegacyStorage,
  appendPromptLog,
  appendResponseLog,
  cleanLegacySiteCustomize
} = require('./src/userStorage');
const {
  clearAllSessionMetadata
} = require('./src/sessionManager');
const {
  executeProgram,
  executeByProjectType,
  startInteractiveSession,
  sendInputToSession,
  stopSession,
  listSessions,
  getSession,
  invalidateSessionsForDeletedTarget,
  getPreviewInfo,
  isPortOwnedByUser
} = require('./src/executor');

const { dbRun, dbAll, dbGet } = require('./src/database');
const { auditLog } = require('./src/auditLogger');
const { trackActivity } = require('./src/userActivity');
const {
  syncPrograms,
  findAndSyncSingleProgram,
  updateProgramExecutionStats,
  checkExecutionBlocked
} = require('./src/programService');
const {
  syncConversations,
  syncSingleConversation,
  checkConversationBlocked
} = require('./src/conversationService');
const {
  getConversationProject,
  linkConversationProject,
  unlinkConversationProject,
  getAllConversationProjects
} = require('./src/conversationProjectService');
const { startMonitoringDaemon } = require('./src/monitorService');
const { trackLlmRequest } = require('./src/aiService');
const { getUserGeneratedRoot } = require('./src/projectManager');

const app = express();
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ipem-web.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];

function buildAllowedOrigins() {
  const configuredOrigins = [
    process.env.FRONTEND_URL,
    process.env.CORS_ALLOWED_ORIGINS
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins])];
}

const allowedOrigins = buildAllowedOrigins();

function normalizeWebhookUrl(rawValue) {
  if (!rawValue) return '';
  const value = rawValue.trim();
  const nestedPrefix = 'N8N_WEBHOOK_URL=';
  return value.startsWith(nestedPrefix) ? value.slice(nestedPrefix.length) : value;
}

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

app.use(requestLoggerMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(securityBanMiddleware);
app.use(auditContextMiddleware);

function sendRouteError(res, err) {
  console.error('API Error:', err);
  const status = err.status || (err.code === 'FILE_DELETED' ? 404 : 500);
  const payload = {
    error: err.code || 'INTERNAL_ERROR',
    message: err.message || 'Internal server error'
  };
  return res.status(status).json(payload);
}

// General error handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  res.status(status).json({ error: message, code: err.code });
});

// ─── STARTUP ─────────────────────────────────────
async function startup() {
  await clearStaleSession();
  const clearedSessions = await clearAllSessionMetadata();
  if (clearedSessions > 0) {
    console.log(`Cleared ${clearedSessions} stale Redis session entries`);
  }
  await migrateFromJson();
  await migrateAllLegacyStorage();
  await cleanLegacySiteCustomize();
}
startup();

// ─── ROUTES ──────────────────────────────────────
const userAccess = [requireAuth, requireActiveStatus, scopeByUser];
app.use('/auth', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/admin', adminRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: true,
    service: "IPEM Execution Agent",
    port: PORT
  });
});

app.get('/webhook-status', async (req, res) => {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    return res.json({ status: false, configured: false });
  }

  try {
    const response = await axios.get(webhookUrl, {
      timeout: 5000,
      maxRedirects: 0,
      responseType: 'text',
      validateStatus: () => true
    });

    const body = typeof response.data === 'string'
      ? response.data.toLowerCase()
      : JSON.stringify(response.data || {}).toLowerCase();
    const headers = response.headers || {};
    const serverHeader = String(headers.server || '').toLowerCase();
    const poweredBy = String(headers['x-powered-by'] || '').toLowerCase();
    const contentType = String(headers['content-type'] || '').toLowerCase();

    const looksLikeN8n =
      serverHeader.includes('n8n') ||
      poweredBy.includes('express') ||
      body.includes('requested webhook') ||
      body.includes('webhook') ||
      body.includes('n8n') ||
      contentType.includes('application/json');

    const isReachable = response.status >= 200 && response.status < 500;
    return res.json({
      status: isReachable && looksLikeN8n,
      configured: true,
      probe_status: response.status
    });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(err.status || 500).json({
      status: false,
      configured: true,
      error: err.message || err.toString()
    });
  }
});

app.get('/languages', ...userAccess, (req, res) => {
  res.json(getLanguageStatus());
});

// Save file — auto detects language
app.post('/save', ...userAccess, async (req, res) => {
  try {
  let { code, program_name, language, packages = [] } = req.body;

  if (!code) return res.status(400).json({ error: 'code is required' });

  const cleanCode = stripCodeFences(code);
  const finalCode = cleanCode.startsWith('"') && cleanCode.endsWith('"')
  ? (() => { try { const p = JSON.parse(cleanCode); return typeof p === 'string' ? p : cleanCode; } catch { return cleanCode; } })()
  : cleanCode;
  const detectedLang = language
    ? (FENCE_MAP[language.toLowerCase()] || language.toLowerCase())
    : detectLanguageFromCode(code);
  const ext = getExtension(detectedLang);
  const folderName = program_name
    ? program_name.toLowerCase().replace(/[^a-z0-9]/g, '_')
    : 'program_' + Date.now();
  const filename = folderName + ext;
  const userRoot = await getUserGeneratedRoot(req.userId);
  const targetDir = path.join(userRoot, folderName);
  const exists = fs.existsSync(targetDir);

  const { programDir } = await ensureUserProgramDir(req.userId, folderName);

  const filePath = path.join(programDir, filename);
  await fs.promises.writeFile(filePath, finalCode, 'utf8');

  // Install packages locally inside program folder
  let installLog = [];
  if (packages && packages.length > 0) {
    for (const pkg of packages) {
      if (!pkg) continue;
      try {
        if (detectedLang === 'python') {
          const venvDir = path.join(programDir, 'venv');
          if (!fs.existsSync(venvDir)) {
            installLog.push(`Creating venv...`);
            execSync(`python -m venv "${venvDir}"`, { stdio: 'pipe' });
          }

          const pipPath = process.platform === 'win32'
            ? path.join(venvDir, 'Scripts', 'pip')
            : path.join(venvDir, 'bin', 'pip');

          installLog.push(`Installing ${pkg}...`);
          execSync(`"${pipPath}" install ${pkg} --quiet`, { stdio: 'pipe' });
          installLog.push(`✅ Python: ${pkg} installed in venv`);

        } else if (detectedLang === 'javascript') {
          execSync(`cd "${programDir}" && npm install ${pkg} --save --quiet`, { stdio: 'pipe' });
          installLog.push(`✅ JS: ${pkg} installed`);
        }
      } catch(err) {
        installLog.push(`❌ Failed: ${pkg} - ${err.message}`);
      }
    }
  }

  await saveLastProgram({
    program_name: folderName,
    filename,
    language: detectedLang,
    packages,
    path: filePath,
    timestamp: new Date().toISOString()
  }, req.userId);

  // Sync program metadata to the database
  await findAndSyncSingleProgram(req.userId, folderName);

  // Log save action (Phase 2)
  await auditLog({
    action: exists ? 'PROGRAM_UPDATED' : 'PROGRAM_CREATED',
    targetType: 'program',
    targetId: folderName,
    newValue: filename,
    metadata: { language: detectedLang, packages }
  });

  // Track activity (Phase 4)
  trackActivity({
    activityType: exists ? 'PROGRAM_UPDATED' : 'PROGRAM_CREATED',
    resourceType: 'program',
    resourceId: folderName,
    resourceName: folderName,
    metadata: { language: detectedLang, filename }
  });

  res.json({
    status: 'saved',
    program_name: folderName,
    filename,
    language: detectedLang,
    packages,
    install_log: installLog,
    path: filePath
  });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── SAVE MULTI-FILE PROJECT ──────────────────────────────────────────────────
/**
 * POST /save-multi
 * Saves a multi-file project atomically. Creates the project directory and writes
 * every file listed in the `files` array. Stores project_meta.json as a sidecar.
 *
 * Body: {
 *   program_name:  string               (required)
 *   project_type:  string               (e.g. "static_html", "flask", "single_file")
 *   entry_file:    string               (e.g. "index.html", "app.py")
 *   language:      string               (e.g. "html", "python")
 *   packages:      string[]             (optional)
 *   files: [{ filename: string, content: string }]   (required)
 * }
 */
app.post('/save-multi', ...userAccess, async (req, res) => {
  try {
    let { program_name, project_type, entry_file, language, packages = [], files,
          original_request, requirements_prompt } = req.body;

    if (!program_name) return res.status(400).json({ error: 'program_name is required' });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required and must not be empty' });
    }

    // Normalise program name
    const folderName = program_name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    const { programDir } = await ensureUserProgramDir(req.userId, folderName);
    const exists = fs.existsSync(programDir) && fs.readdirSync(programDir).some(f => f !== 'project_meta.json');

    // Write every file
    const savedFilenames = [];
    for (const fileEntry of files) {
      const { filename, content } = fileEntry;
      if (!filename || typeof content !== 'string') {
        return res.status(400).json({ error: `Each file must have a filename and content string` });
      }

      // Security: reject path traversal
      const segments = filename.split(/[/\\]/);
      if (segments.some(s => s === '..' || s === '.')) {
        return res.status(400).json({ error: `Invalid filename: ${filename}` });
      }

      const filePath = path.join(programDir, filename);
      // Ensure sub-directories exist (e.g. src/components/Button.jsx)
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, 'utf8');
      savedFilenames.push(filename);
    }

    // Install packages (Python venv / npm)
    let installLog = [];
    if (packages && packages.length > 0) {
      for (const pkg of packages) {
        if (!pkg) continue;
        try {
          if (language === 'python') {
            const venvDir = path.join(programDir, 'venv');
            if (!fs.existsSync(venvDir)) {
              installLog.push('Creating venv...');
              const { execSync } = require('child_process');
              execSync(`python -m venv "${venvDir}"`, { stdio: 'pipe' });
            }
            const pipPath = process.platform === 'win32'
              ? path.join(venvDir, 'Scripts', 'pip')
              : path.join(venvDir, 'bin', 'pip');
            const { execSync: execS } = require('child_process');
            execS(`"${pipPath}" install ${pkg} --quiet`, { stdio: 'pipe' });
            installLog.push(`✅ Python: ${pkg} installed in venv`);
          } else if (language === 'javascript' || language === 'node') {
            const { execSync: execS } = require('child_process');
            execS(`cd "${programDir}" && npm install ${pkg} --save --quiet`, { stdio: 'pipe' });
            installLog.push(`✅ JS: ${pkg} installed`);
          }
        } catch (err) {
          installLog.push(`❌ Failed: ${pkg} - ${err.message}`);
        }
      }
    }

    // Auto-detect static_html if HTML files exist and no backend server code exists
    const hasHtml = savedFilenames.some(f => f.endsWith('.html'));
    const hasBackendCode = files.some(f => {
      const c = f.content || '';
      return c.includes("require('express')") || c.includes("from 'express'") || c.includes('from express') ||
             c.includes('from flask') || c.includes('from fastapi') || c.includes('http.createServer');
    });

    if (hasHtml && !hasBackendCode) {
      project_type = 'static_html';
      entry_file = savedFilenames.find(f => f === 'index.html') || savedFilenames.find(f => f.endsWith('.html')) || 'index.html';
      language = 'html';
      packages = [];
    }

    // Write project_meta.json sidecar
    await saveProjectMeta(req.userId, folderName, {
      project_type:         project_type       || 'single_file',
      entry_file:           entry_file         || savedFilenames[0],
      language:             language           || null,
      files:                savedFilenames,
      original_request:     original_request   || null,
      requirements_prompt:  requirements_prompt || null
    });

    // ── ONE CONVERSATION = ONE PROJECT ──────────────────────────────────────
    // Link (or update metadata for) the conversation → project binding.
    // The sessionId must be passed in the request body by the n8n workflow.
    const sessionId = req.body.sessionId || req.body.session_id || null;
    if (sessionId) {
      const { programsRoot } = await require('./src/userStorage').getUserStoragePaths(req.userId);
      const rootDir = require('path').join(programsRoot, folderName);
      await linkConversationProject(req.userId, sessionId, {
        program_name:   folderName,
        project_type:   project_type   || 'single_file',
        language:       language        || null,
        entry_file:     entry_file      || savedFilenames[0],
        root_directory: rootDir,
        packages
      });
    }

    // Persist as last program
    const primaryFilename = entry_file || savedFilenames[0];
    await saveLastProgram({
      program_name: folderName,
      filename:     primaryFilename,
      language:     language || null,
      project_type: project_type || 'single_file',
      packages,
      path: path.join(programDir, primaryFilename),
      timestamp: new Date().toISOString()
    }, req.userId);

    // Sync program metadata to the database
    await findAndSyncSingleProgram(req.userId, folderName);

    // Audit log
    await auditLog({
      action: exists ? 'PROGRAM_UPDATED' : 'PROGRAM_CREATED',
      targetType: 'program',
      targetId: folderName,
      newValue: primaryFilename,
      metadata: { project_type, language, packages, file_count: savedFilenames.length }
    });

    trackActivity({
      activityType: exists ? 'PROGRAM_UPDATED' : 'PROGRAM_CREATED',
      resourceType: 'program',
      resourceId: folderName,
      resourceName: folderName,
      metadata: { language, project_type, files: savedFilenames }
    });

    res.json({
      status: 'saved',
      program_name: folderName,
      project_type: project_type || 'single_file',
      entry_file:   primaryFilename,
      language:     language || null,
      files:        savedFilenames,
      install_log:  installLog
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── PATCH (IN-PLACE REPAIR) ──────────────────────────────────────────────────
/**
 * POST /patch
 * Updates only the specified files inside an EXISTING project directory.
 * Never creates a new directory. Used by the repair workflow so each fix
 * iteration writes into the same project rather than creating a new one.
 *
 * Body: {
 *   program_name: string
 *   files: [{ filename: string, content: string }]
 * }
 */
app.post('/patch', ...userAccess, async (req, res) => {
  try {
    const { program_name, files } = req.body;

    if (!program_name) return res.status(400).json({ error: 'program_name is required' });
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }

    // Enforce that the directory ALREADY EXISTS — never create a new one
    const { programDir } = await getSafeProgramDir(req.userId, program_name);

    const patchedFilenames = [];
    for (const fileEntry of files) {
      const { filename, content } = fileEntry;
      if (!filename || typeof content !== 'string') {
        return res.status(400).json({ error: `Each file must have a filename and content string` });
      }

      // Security: reject path traversal
      const segments = filename.split(/[/\\]/);
      if (segments.some(s => s === '..' || s === '.')) {
        return res.status(400).json({ error: `Invalid filename: ${filename}` });
      }

      const filePath = path.join(programDir, filename);
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, content, 'utf8');
      patchedFilenames.push(filename);
    }

    // Update project_meta.json timestamp (keep all other fields intact)
    const existingMeta = await readProjectMeta(req.userId, program_name);
    if (existingMeta) {
      await saveProjectMeta(req.userId, program_name, {
        ...existingMeta,
        updated_at: new Date().toISOString()
      });
    }

    // Sync program metadata to the database
    await findAndSyncSingleProgram(req.userId, program_name);

    // Link / refresh conversation project binding
    const sessionId = req.body.sessionId || req.body.session_id || null;
    if (sessionId) {
      const { programsRoot } = await require('./src/userStorage').getUserStoragePaths(req.userId);
      const rootDir = require('path').join(programsRoot, program_name);
      await linkConversationProject(req.userId, sessionId, {
        program_name:   program_name,
        project_type:   existingMeta?.project_type || 'single_file',
        language:       existingMeta?.language || null,
        entry_file:     existingMeta?.entry_file || null,
        root_directory: rootDir
      });
    }

    await auditLog({
      action: 'PROGRAM_UPDATED',
      targetType: 'program',
      targetId: program_name,
      newValue: patchedFilenames.join(', '),
      reason: 'patch_repair'
    });

    trackActivity({
      activityType: 'PROGRAM_UPDATED',
      resourceType: 'program',
      resourceId: program_name,
      resourceName: program_name,
      metadata: { patched_files: patchedFilenames }
    });

    res.json({
      status: 'patched',
      program_name,
      patched_files: patchedFilenames
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── GET PROJECT META ─────────────────────────────────────────────────────────
/**
 * GET /project-meta/:programName
 * Returns the project_meta.json sidecar for a given program.
 * Used by n8n workflow to decide the execution strategy.
 */
app.get('/project-meta/:programName', ...userAccess, async (req, res) => {
  try {
    const meta = await readProjectMeta(req.userId, req.params.programName);
    if (!meta) {
      return res.status(404).json({ error: 'No project metadata found', project_type: 'single_file' });
    }
    res.json({ program_name: req.params.programName, ...meta });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── GET ALL PROGRAM FILES (for repair context) ───────────────────────────────
/**
 * GET /program-files/:programName
 * Returns all source files of a program with their full content.
 * Used by the n8n Code Rewriter node to understand the project structure.
 */
app.get('/program-files/:programName', ...userAccess, async (req, res) => {
  try {
    const programName = req.params.programName;
    const { programDir } = await getSafeProgramDir(req.userId, programName);
    const meta = await readProjectMeta(req.userId, programName);

    const SKIP_DIRS  = new Set(['venv', 'node_modules', '__pycache__', '.git']);
    const SKIP_FILES = new Set(['project_meta.json', 'sitecustomize.py']);
    const MAX_FILE_SIZE = 256 * 1024; // 256 KB per file

    const filesList = [];

    async function walkDir(dir, relBase) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
          await walkDir(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          if (SKIP_FILES.has(entry.name)) continue;
          const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
          const fullPath = path.join(dir, entry.name);
          try {
            const stat = await fs.promises.stat(fullPath);
            if (stat.size > MAX_FILE_SIZE) {
              filesList.push({ filename: relPath, content: `[File too large: ${stat.size} bytes]` });
            } else {
              const content = await fs.promises.readFile(fullPath, 'utf8');
              filesList.push({ filename: relPath, content });
            }
          } catch (_) {}
        }
      }
    }

    await walkDir(programDir, '');

    res.json({
      program_name:        programName,
      project_type:        meta?.project_type         || 'single_file',
      entry_file:          meta?.entry_file            || null,
      language:            meta?.language              || null,
      original_request:    meta?.original_request      || null,
      requirements_prompt: meta?.requirements_prompt   || null,
      files:               filesList
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get('/programs', ...userAccess, async (req, res) => {

  try {
    const rows = await dbAll(
      "SELECT name, language, status, visibility, storage_size_bytes FROM programs WHERE owner_user_id = ? AND deleted_at IS NULL",
      [req.userId]
    );

    const { getUserStoragePaths } = require('./src/userStorage');
    const paths = await getUserStoragePaths(req.userId);
    const programsList = [];

    for (const row of rows) {
      const dirPath = path.join(paths.programsRoot, row.name);
      let files = [];
      try {
        if (fs.existsSync(dirPath)) {
          files = fs.readdirSync(dirPath).filter(f => f !== 'sitecustomize.py');
        }
      } catch (_) {}

      programsList.push({
        program_name: row.name,
        files,
        language: row.language,
        status: row.status,
        visibility: row.visibility,
        storage_size_bytes: row.storage_size_bytes
      });
    }

    res.json(programsList);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.delete('/api/program/:programName', requireAuth, requireActiveStatus, async (req, res) => {
  try {
    let targetUserId = req.user.userId;
    if (req.query.userId && req.query.userId !== String(req.user.userId)) {
      const { hasRole } = require('./src/rbac');
      if (!hasRole(req.user.role, 'admin')) {
        return res.status(403).json({ error: 'Forbidden: Insufficient role to delete other user programs', code: 'FORBIDDEN' });
      }
      targetUserId = parseInt(req.query.userId, 10);
    }

    const programName = req.params.programName;
    const invalidatedSessions = invalidateSessionsForDeletedTarget(targetUserId, programName);
    const result = await deleteProgram(targetUserId, programName);

    // Soft delete the program in database
    await dbRun(
      "UPDATE programs SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL",
      [targetUserId, programName]
    );

    // Log program deletion (Phase 2)
    await auditLog({
      action: 'PROGRAM_DELETED',
      targetType: 'program',
      targetId: programName
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_DELETED',
      resourceType: 'program',
      resourceId: programName,
      resourceName: programName
    });

    res.json({
      status: 'deleted',
      type: 'program',
      ...result,
      invalidated_sessions: invalidatedSessions
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.delete('/api/program/:programName/file/*fileName', requireAuth, requireActiveStatus, async (req, res) => {
  try {
    let targetUserId = req.user.userId;
    if (req.query.userId && req.query.userId !== String(req.user.userId)) {
      const { hasRole } = require('./src/rbac');
      if (!hasRole(req.user.role, 'admin')) {
        return res.status(403).json({ error: 'Forbidden: Insufficient role to delete other user program files', code: 'FORBIDDEN' });
      }
      targetUserId = parseInt(req.query.userId, 10);
    }

    const programName = req.params.programName;
    const fileName = Array.isArray(req.params.fileName) ? req.params.fileName.join('/') : req.params.fileName;
    const invalidatedSessions = invalidateSessionsForDeletedTarget(targetUserId, programName, fileName);
    const result = await deleteProgramFile(targetUserId, programName, fileName);

    // Sync program size / metadata changes
    await findAndSyncSingleProgram(targetUserId, programName);

    // Log program update (file deletion) (Phase 2)
    await auditLog({
      action: 'PROGRAM_UPDATED',
      targetType: 'program',
      targetId: programName,
      oldValue: fileName,
      reason: 'file_deleted'
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_UPDATED',
      resourceType: 'program',
      resourceId: programName,
      resourceName: programName,
      metadata: { deleted_file: fileName }
    });

    res.json({
      status: 'deleted',
      type: 'file',
      ...result,
      invalidated_sessions: invalidatedSessions
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.put('/api/program/:programName/file/*fileName', requireAuth, requireActiveStatus, async (req, res) => {
  try {
    let targetUserId = req.user.userId;
    if (req.query.userId && req.query.userId !== String(req.user.userId)) {
      const { hasRole } = require('./src/rbac');
      if (!hasRole(req.user.role, 'admin')) {
        return res.status(403).json({ error: 'Forbidden: Insufficient role to edit other user programs', code: 'FORBIDDEN' });
      }
      targetUserId = parseInt(req.query.userId, 10);
    }

    const { content } = req.body || {};
    const fileName = Array.isArray(req.params.fileName) ? req.params.fileName.join('/') : req.params.fileName;
    const result = await updateProgramFile(targetUserId, req.params.programName, fileName, content);

    // Sync program size / metadata changes
    await findAndSyncSingleProgram(targetUserId, req.params.programName);

    // Log program update (file updated) (Phase 2)
    await auditLog({
      action: 'PROGRAM_UPDATED',
      targetType: 'program',
      targetId: req.params.programName,
      newValue: fileName,
      reason: 'file_updated'
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_UPDATED',
      resourceType: 'program',
      resourceId: req.params.programName,
      resourceName: req.params.programName,
      metadata: { updated_file: fileName }
    });

    res.json({ success: true, ...result });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get('/last-program', ...userAccess, async (req, res) => {
  const last = await getLastProgram(req.userId);
  if (!last) return res.status(404).json({ error: 'No program generated yet' });
  res.json(last);
});

function getPublicBackendBaseUrl(req) {
  const envUrl = process.env.IPEM_UPSTREAM_URL || process.env.PUBLIC_BACKEND_URL || process.env.VITE_API_BASE_URL;
  if (envUrl && envUrl.startsWith('http') && !envUrl.includes('host.docker.internal')) {
    return envUrl.replace(/\/+$/, '');
  }
  const host = req?.headers?.host || '';
  const isInternal = host.includes('host.docker.internal') || host.includes('localhost') || host.includes('127.0.0.1') || host.includes(':9000');
  if (!isInternal && host.length > 0) {
    const protocol = req?.headers?.['x-forwarded-proto'] || req?.protocol || 'https';
    return `${protocol}://${host}`.replace(/\/+$/, '');
  }
  return process.env.PUBLIC_BACKEND_URL || 'http://localhost:9000';
}

app.post('/execute', ...userAccess, async (req, res) => {
  let { program_name, filename, timeout = 30000 } = req.body;
  try {
    // Resolve program name (use last program if not supplied)
    if (!program_name) {
      const last = await getLastProgram(req.userId);
      if (!last) return res.status(404).json({ error: 'No program found. Generate one first.' });
      program_name = last.program_name;
    }
    program_name = program_name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Check if execution is blocked (disabled, suspended, locked)
    const blockCheck = await checkExecutionBlocked(req.userId, program_name);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: `Execution Blocked: ${blockCheck.reason}` });
    }

    const startTime = Date.now();

    // Route by project type (handles static_html, flask, node, single_file, etc.)
    const log = await executeByProjectType(req.userId, program_name, timeout);
    const durationMs = Date.now() - startTime;

    // Static HTML projects return a preview descriptor — no real execution happened
    if (log.project_type === 'static_html') {
      if (log.preview_url) {
        const pathPart = log.preview_url.startsWith('http')
          ? new URL(log.preview_url).pathname
          : log.preview_url;
        log.preview_url = `${getPublicBackendBaseUrl(req)}${pathPart}`;
      }
      await auditLog({
        action: 'PROGRAM_EXECUTED',
        targetType: 'program',
        targetId: program_name,
        metadata: { interactive: false, project_type: 'static_html', preview_url: log.preview_url }
      });
      trackActivity({
        activityType: 'PROGRAM_EXECUTED',
        resourceType: 'program',
        resourceId: program_name,
        resourceName: program_name,
        metadata: { project_type: 'static_html', preview_url: log.preview_url }
      });
      return res.json(log);
    }

    // Track execution stats in the database
    const isSuccess = log.status === 'SUCCESS';
    await updateProgramExecutionStats(req.userId, program_name, isSuccess, durationMs);

    // Log program execution (Phase 2)
    await auditLog({
      action: 'PROGRAM_EXECUTED',
      targetType: 'program',
      targetId: program_name,
      newValue: log.filename || filename,
      metadata: { interactive: false, timeout }
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_EXECUTED',
      resourceType: 'program',
      resourceId: program_name,
      resourceName: program_name,
      metadata: { filename: log.filename || filename, interactive: false }
    });

    res.json(log);
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── INTERACTIVE EXECUTION ───────────────────────

app.post('/execute/start',...userAccess, async (req, res) => {
  let { program_name, filename } = req.body;

  try {
    // Resolve program name (use last program if not supplied)
    if (!program_name) {
      const last = await getLastProgram(req.userId);
      if (!last) return res.status(404).json({ error: 'No program found. Generate one first.' });
      program_name = last.program_name;
    }
    program_name = program_name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    // Check if execution is blocked
    const blockCheck = await checkExecutionBlocked(req.userId, program_name);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: `Execution Blocked: ${blockCheck.reason}` });
    }

    // Increment execution count and set last executed time
    await dbRun(`
      UPDATE programs
      SET execution_count = execution_count + 1, last_executed_at = CURRENT_TIMESTAMP
      WHERE owner_user_id = ? AND name = ? AND deleted_at IS NULL
    `, [req.userId, program_name]);

    // Route by project type
    const result = await executeByProjectType(req.userId, program_name);

    // ── static_html: return preview URL immediately (no session) ──────────────
    if (result.project_type === 'static_html') {
      if (result.preview_url) {
        const pathPart = result.preview_url.startsWith('http')
          ? new URL(result.preview_url).pathname
          : result.preview_url;
        result.preview_url = `${getPublicBackendBaseUrl(req)}${pathPart}`;
      }
      await auditLog({
        action: 'PROGRAM_EXECUTED',
        targetType: 'program',
        targetId: program_name,
        metadata: { interactive: false, project_type: 'static_html', preview_url: result.preview_url }
      });
      trackActivity({
        activityType: 'PROGRAM_EXECUTED',
        resourceType: 'program',
        resourceId: program_name,
        resourceName: program_name,
        metadata: { project_type: 'static_html', preview_url: result.preview_url }
      });
      return res.json({
        program_name,
        project_type: 'static_html',
        entry_file: result.entry_file,
        filename: result.entry_file,
        status: 'SUCCESS',
        preview: true,
        preview_url: result.preview_url,
        message: `✅ ${program_name} is a static website. Open the preview to view it.`
      });
    }

    // ── Non-interactive single-file execution: return result immediately ────────
    if (!result.session_id) {
      await auditLog({
        action: 'PROGRAM_EXECUTED',
        targetType: 'program',
        targetId: program_name,
        metadata: { interactive: false, project_type: result.project_type || 'single_file' }
      });
      trackActivity({
        activityType: 'PROGRAM_EXECUTED',
        resourceType: 'program',
        resourceId: program_name,
        resourceName: program_name,
        metadata: { project_type: result.project_type || 'single_file' }
      });
      return res.json({
        program_name,
        filename: result.filename,
        entry_file: result.filename,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        message: `✅ ${program_name} completed execution.`
      });
    }

    // ── Interactive session (server / single-file) ─────────────────────────────
    const { session_id, lang, outputBuffer, waitingForInput, filename } = result;

    // Log program execution start (Phase 2)
    await auditLog({
      action: 'PROGRAM_EXECUTED',
      targetType: 'program',
      targetId: program_name,
      metadata: { interactive: true, session_id }
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_EXECUTED',
      resourceType: 'program',
      resourceId: program_name,
      resourceName: program_name,
      metadata: { interactive: true, session_id }
    });

    const waitTime = lang === 'javascript' ? 5000 : 3000;
    setTimeout(() => {
      const session = getSession(session_id, req.userId);
      res.json({
        session_id,
        program_name,
        filename: filename || (session ? session.filename : undefined),
        status: 'RUNNING',
        initial_output: session ? session.getOutput() : outputBuffer,
        waiting_for_input: session ? session.isWaiting() : waitingForInput,
        message: `✅ ${program_name} started! Session: ${session_id}`
      });
    }, waitTime);
  } catch (err) {
    console.error('Execute Start Error:', err.message);
    sendRouteError(res, err);
  }
});

app.post('/execute/input', ...userAccess, (req, res) => {
  const { session_id, input } = req.body;
  try {
    const result = sendInputToSession(session_id, input, req.userId);
    if (result.program_finished) return res.json(result);

    setTimeout(() => {
      const session = getSession(session_id, req.userId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
      res.json({
        session_id,
        status: session.running ? 'RUNNING' : session.status,
        output: session.getOutput(),
        error: session.getError(),
        waiting_for_input: session.isWaiting(),
        program_finished: !session.running
      });
    }, 3000);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/execute/status/:session_id', ...userAccess, (req, res) => {
  const session = getSession(req.params.session_id, req.userId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  res.json({
    session_id: req.params.session_id,
    program_name: session.program_name,
    status: session.status,
    running: session.running,
    output: session.getOutput(),
    error: session.getError(),
    waiting_for_input: session.isWaiting()
  });
});

app.post('/execute/stop/:session_id', ...userAccess, async (req, res) => {
  try {
    const result = stopSession(req.params.session_id, req.userId);

    // Log program stopped (Phase 2)
    await auditLog({
      action: 'PROGRAM_STOPPED',
      targetType: 'program',
      targetId: result.program_name || null,
      metadata: { session_id: req.params.session_id }
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'PROGRAM_STOPPED',
      resourceType: 'program',
      resourceId: result.program_name || null,
      resourceName: result.program_name || null,
      metadata: { session_id: req.params.session_id }
    });

    res.json({ ...result, message: '⛔ Program stopped.' });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/execute/sessions', ...userAccess, async (req, res) => {
  res.json(await listSessions(req.userId));
});

// ─── PREVIEW ROUTES ──────────────────────────────

// MIME types for static file serving (HTML programs)
const PREVIEW_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.txt':  'text/plain',
  '.xml':  'text/xml',
};

/**
 * GET /execute/preview/:session_id
 * Returns preview info (detected port) for a running session owned by the user.
 * The frontend polls this after program start to detect when a server is ready.
 */
app.get('/execute/preview/:session_id', ...userAccess, (req, res) => {
  const info = getPreviewInfo(req.params.session_id, req.userId);
  if (!info) return res.json({ preview: false });
  res.json({ preview: true, ...info });
});

/**
 * GET /preview/port/:port/*
 * Authenticated transparent proxy to a local server started by the user's program.
 * Security: the port must belong to an active session owned by the requesting user.
 * Strips X-Frame-Options and CSP headers so the proxied page renders in the iframe.
 */
app.get('/preview/port/:port/*subpath', ...userAccess, async (req, res) => {
  const port = parseInt(req.params.port, 10);
  if (!port || port < 1024 || port > 65535) {
    return res.status(400).json({ error: 'Invalid port' });
  }

  // Security gate: only proxy if this port belongs to the user's session
  if (!isPortOwnedByUser(port, req.userId)) {
    return res.status(403).json({ error: 'Preview not available: port does not belong to your session' });
  }

  const subpath = (req.params.subpath || '').replace(/^\/+/, '');
  const query = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
  const targetUrl = `http://127.0.0.1:${port}/${subpath}${query}`;

  try {
    // Use Node's built-in http to forward the request
    const http = require('http');
    const targetUrlObj = new URL(targetUrl);
    const options = {
      hostname: '127.0.0.1',
      port,
      path: targetUrlObj.pathname + targetUrlObj.search,
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${port}`,
        // Remove headers that might cause issues downstream
        'accept-encoding': 'identity'
      },
      timeout: 15000
    };
    delete options.headers['if-none-match'];
    delete options.headers['if-modified-since'];

    const proxyReq = http.request(options, (proxyRes) => {
      const blockedHeaders = new Set([
        'x-frame-options',
        'content-security-policy',
        'content-security-policy-report-only',
        'cross-origin-opener-policy',
        'cross-origin-embedder-policy',
      ]);
      res.status(proxyRes.statusCode);
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (!blockedHeaders.has(key.toLowerCase())) {
          res.setHeader(key, val);
        }
      }
      // Allow iframe embedding
      const frameAncestors = ["'self'", ...allowedOrigins].join(' ');
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: 'Preview server not ready', message: err.message });
      }
    });
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Preview server timed out' });
    });
    proxyReq.end();
  } catch (err) {
    console.error('Preview proxy error:', err);
    if (!res.headersSent) res.status(502).json({ error: 'Preview proxy failed', message: err.message });
  }
});

/**
 * GET /preview/html/:program_name/*
 * Serves static files from a user's HTML program directory.
 * Used when the program is a static website (index.html, CSS, JS assets, images).
 * Security: validates the file belongs to the authenticated user via getSafeProgramFile.
 */
app.get('/preview/html/:program_name', ...userAccess, (req, res, next) => {
  if (!req.path.endsWith('/')) {
    const query = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    return res.redirect(301, `/preview/html/${req.params.program_name}/${query}`);
  }
  next();
});

app.get('/preview/html/:program_name/', ...userAccess, async (req, res) => {
  try {
    const programName = req.params.program_name;
    const meta = await readProjectMeta(req.userId, programName);

    // Verify it is a static HTML project
    let isHtmlProject = false;
    let entryFile = 'index.html';

    if (meta) {
      if (meta.project_type === 'static_html' || meta.language === 'html' || (meta.entry_file && meta.entry_file.endsWith('.html'))) {
        isHtmlProject = true;
        entryFile = meta.entry_file || 'index.html';
      }
    }

    // Directory check fallback
    const { getSafeProgramDir } = require('./src/projectManager');
    let programDir;
    try {
      const dirResult = await getSafeProgramDir(req.userId, programName);
      programDir = dirResult.programDir;
      const files = fs.readdirSync(programDir);
      const htmlFiles = files.filter(f => f.endsWith('.html'));
      if (htmlFiles.length > 0) {
        isHtmlProject = true;
        entryFile = htmlFiles.includes('index.html') ? 'index.html' : htmlFiles[0];
      }
    } catch (e) {}

    // File content check fallback
    if (!isHtmlProject && programDir) {
      try {
        const { resolveProgramAndFile } = require('./src/projectManager');
        const resolved = await resolveProgramAndFile(req.userId, programName, null);
        if (resolved && resolved.filename) {
          const filePath = path.join(programDir, resolved.filename);
          const content = fs.readFileSync(filePath, 'utf8');
          const trimmed = content.trim().toLowerCase();
          if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || resolved.filename.endsWith('.html')) {
            isHtmlProject = true;
            entryFile = resolved.filename;
          }
        }
      } catch (e) {}
    }

    if (!isHtmlProject) {
      return res.status(400).json({ error: 'Project is not a static HTML project.' });
    }

    const result = await getSafeProgramFile(req.userId, programName, entryFile);
    const filePath = result.filePath;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const frameAncestors = ["'self'", ...allowedOrigins].join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);

    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(err.status || 500).end();
      }
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.get('/preview/html/:program_name/*filepath', ...userAccess, async (req, res) => {
  try {
    const programName = req.params.program_name;
    const meta = await readProjectMeta(req.userId, programName);

    // Verify it is a static HTML project
    let isHtmlProject = false;
    let entryFile = 'index.html';

    if (meta) {
      if (meta.project_type === 'static_html' || meta.language === 'html' || (meta.entry_file && meta.entry_file.endsWith('.html'))) {
        isHtmlProject = true;
        entryFile = meta.entry_file || 'index.html';
      }
    }

    // Directory check fallback
    const { getSafeProgramDir } = require('./src/projectManager');
    let programDir;
    try {
      const dirResult = await getSafeProgramDir(req.userId, programName);
      programDir = dirResult.programDir;
      const files = fs.readdirSync(programDir);
      const htmlFiles = files.filter(f => f.endsWith('.html'));
      if (htmlFiles.length > 0) {
        isHtmlProject = true;
        entryFile = htmlFiles.includes('index.html') ? 'index.html' : htmlFiles[0];
      }
    } catch (e) {}

    // File content check fallback
    if (!isHtmlProject && programDir) {
      try {
        const { resolveProgramAndFile } = require('./src/projectManager');
        const resolved = await resolveProgramAndFile(req.userId, programName, null);
        if (resolved && resolved.filename) {
          const filePath = path.join(programDir, resolved.filename);
          const content = fs.readFileSync(filePath, 'utf8');
          const trimmed = content.trim().toLowerCase();
          if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || resolved.filename.endsWith('.html')) {
            isHtmlProject = true;
            entryFile = resolved.filename;
          }
        }
      } catch (e) {}
    }

    if (!isHtmlProject) {
      return res.status(400).json({ error: 'Project is not a static HTML project.' });
    }

    let filepath = req.params.filepath;
    if (Array.isArray(filepath)) {
      filepath = filepath.join('/');
    }
    let relPath = filepath || 'index.html';
    // Clean up leading/trailing slashes
    relPath = relPath.replace(/^\/+/, '');
    if (!relPath) {
      relPath = 'index.html';
    }

    // Find/serve the file safely
    let filePath;
    try {
      const result = await getSafeProgramFile(req.userId, programName, relPath);
      filePath = result.filePath;
    } catch (e) {
      // Try appending index.html
      if (!relPath.endsWith('index.html')) {
        try {
          const withIndex = relPath.replace(/\/$/, '') + '/index.html';
          const result = await getSafeProgramFile(req.userId, programName, withIndex);
          filePath = result.filePath;
        } catch (innerErr) {
          return res.status(404).json({ error: 'File not found' });
        }
      } else {
        return res.status(404).json({ error: 'File not found' });
      }
    }

    // Serve the file (behave exactly like opening the project locally)
    const ext = path.extname(filePath).toLowerCase();
    const contentType = PREVIEW_MIME_TYPES[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    const frameAncestors = ["'self'", ...allowedOrigins].join(' ');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);

    // Serve as normal website using res.sendFile
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(err.status || 500).end();
      }
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});


app.get('/read/:program_name/*filename', requireAuth, requireActiveStatus, (req, res) => {
  let targetUserId = req.user.userId;
  if (req.query.userId && req.query.userId !== String(req.user.userId)) {
    const { hasRole } = require('./src/rbac');
    if (!hasRole(req.user.role, 'moderator')) {
      return res.status(403).json({ error: 'Forbidden: Insufficient role to view other user programs', code: 'FORBIDDEN' });
    }
    targetUserId = parseInt(req.query.userId, 10);
  }

  const filename = Array.isArray(req.params.filename) ? req.params.filename.join('/') : req.params.filename;
  getSafeProgramFile(targetUserId, req.params.program_name, filename)
    .then(({ programName, fileName, filePath }) => {
      res.json({
        program_name: programName,
        filename: fileName,
        code: fs.readFileSync(filePath, 'utf8')
      });
    })
    .catch((err) => sendRouteError(res, err));
});

app.get('/memory', ...userAccess, async (req, res) => {
  try {
    const mem = await getMemory(req.userId);
    res.json(mem);
  } catch (err) {
    sendRouteError(res, err);
  }
});

app.post('/memory', ...userAccess, async (req, res) => {
  try {
    const updated = await updateMemory(req.body, req.userId);

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'MEMORY_UPDATED',
      resourceType: 'memory',
      resourceId: req.userId,
      metadata: { keys: Object.keys(req.body || {}) }
    });

    res.json(updated);
  } catch (err) {
    sendRouteError(res, err);
  }
});


// ─── ASYNC CHAT JOB ENGINE ──────────────────────────────────────────────────
const activeJobs = new Map();

async function processChatJobAsync({ jobId, userId, userEmail, chatInput, sessionId, history, context, token, model }) {
  const startTime = Date.now();
  const N8N_WEBHOOK =
    normalizeWebhookUrl(process.env.N8N_WEBHOOK_URL) ||
    '';

  let jobState = {
    jobId,
    userId,
    sessionId: sessionId || 'ui_default',
    status: 'processing',
    startTime,
    result: null,
    error: null
  };
  activeJobs.set(jobId, jobState);

  if (N8N_WEBHOOK) {
    try {
      const activeProject = await getConversationProject(userId, sessionId || 'ui_default', true);
      const r = await axios.post(
        N8N_WEBHOOK,
        {
          userId,
          userEmail,
          message: chatInput,
          chatInput,
          sessionId: sessionId || 'ui_default',
          history,
          context,
          model: model || 'fast',
          has_project: !!activeProject,
          existing_project: activeProject || null
        },
        {
          timeout: 900000,
          headers: {
            Authorization: `Bearer ${token}`
          }
        }
      );

      const latencyMs = Date.now() - startTime;

      try {
        await appendResponseLog(userId, {
          session_id: sessionId || 'ui_default',
          response: r.data
        });
      } catch (err) {
        console.warn('Failed to append response log:', err.message);
      }

      // Track AI telemetry in database
      try {
        const respStr = typeof r.data === 'string' ? r.data : (r.data?.output || r.data?.message || JSON.stringify(r.data));
        const pLen = (chatInput || '').length;
        const cLen = (respStr || '').length;
        const inToks = Math.max(1, Math.ceil(pLen / 4));
        const outToks = Math.max(1, Math.ceil(cLen / 4));
        const modelName = r.data?.model || 'qwen2.5-coder:7b';
        const providerName = r.data?.provider || 'LiteLLM';

        await trackLlmRequest({
          userId,
          sessionId: sessionId || 'ui_default',
          provider: providerName,
          model: modelName,
          inputTokens: inToks,
          outputTokens: outToks,
          promptLength: pLen,
          completionLength: cLen,
          promptText: chatInput,
          completionText: respStr,
          latencyMs,
          success: true
        });
      } catch (trackErr) {
        console.warn('[AI Telemetry] Failed to log chat request:', trackErr.message);
      }

      jobState.status = 'completed';
      jobState.result = r.data;
      activeJobs.set(jobId, jobState);

      await dbRun(
        `UPDATE llm_jobs SET status = 'completed', result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`,
        [JSON.stringify(r.data), jobId]
      );
      return;
    } catch (err) {
      console.error('n8n ERROR:', err.message);
      if (err.response) {
        console.error('n8n STATUS:', err.response.status);
        console.error('n8n DATA:', err.response.data);
      }

      const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
      const isUnreachable = err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND';

      const message = isTimeout
        ? '⏱️ n8n took too long to respond. The workflow may still be running.'
        : isUnreachable
        ? '⚠️ n8n not reachable. Check if ngrok is running.'
        : `⚠️ n8n error: ${err.message}`;

      const fallbackPayload = { output: message, debug: err.message };

      try {
        await appendResponseLog(userId, {
          session_id: sessionId || 'ui_default',
          response: fallbackPayload
        });
      } catch (logErr) {
        console.warn('Failed to append response log:', logErr.message);
      }

      jobState.status = 'completed';
      jobState.result = fallbackPayload;
      jobState.error = err.message;
      activeJobs.set(jobId, jobState);

      await dbRun(
        `UPDATE llm_jobs SET status = 'completed', result_json = ?, error_text = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`,
        [JSON.stringify(fallbackPayload), err.message, jobId]
      );
      return;
    }
  }

  // Fallback mode if N8N_WEBHOOK is disabled
  const mem = await getMemory(userId);
  const fallbackPayload = {
    output: `[Direct mode] Received: "${chatInput}"\n\nContext window: ${history.length} prior turns loaded.\n\nCurrent facts: ${JSON.stringify(mem, null, 2)}\n\nTo enable full AI responses, set N8N_WEBHOOK_URL.`,
    session_id: sessionId,
    history_length: history.length
  };

  jobState.status = 'completed';
  jobState.result = fallbackPayload;
  activeJobs.set(jobId, jobState);

  await dbRun(
    `UPDATE llm_jobs SET status = 'completed', result_json = ?, updated_at = CURRENT_TIMESTAMP WHERE job_id = ?`,
    [JSON.stringify(fallbackPayload), jobId]
  );
}

// ─── CHAT ENDPOINT (Async Job Model) ─────────────────────────────────────
const handlePostChat = async (req, res) => {
  const userId = req.userId;
  const userEmail = req.user.email;
  const { chatInput, sessionId, history = [], context = '' } = req.body;

  if (!chatInput) {
    return res.status(400).json({ error: 'chatInput required' });
  }

  try {
    await appendPromptLog(userId, {
      session_id: sessionId || 'ui_default',
      user_email: userEmail,
      prompt: chatInput
    });
  } catch (err) {
    console.warn('Failed to append prompt log:', err.message);
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

  try {
    await dbRun(
      `INSERT INTO llm_jobs (job_id, user_id, session_id, status, prompt_text) VALUES (?, ?, ?, 'processing', ?)`,
      [jobId, userId, sessionId || 'ui_default', chatInput]
    );
  } catch (dbErr) {
    console.warn('Failed to insert job into database:', dbErr.message);
  }

  // New clients poll the job endpoint. Older cached clients expect /chat to
  // return the reply itself, so keep them working during frontend rollouts.
  const jobPromise = processChatJobAsync({
    jobId,
    userId,
    userEmail,
    chatInput,
    sessionId: sessionId || 'ui_default',
    history,
    context,
    token: req.token,
    model: req.body.model || 'fast'
  });

  if (req.body.supportsAsyncChatJobs !== true) {
    await jobPromise;
    const completedJob = activeJobs.get(jobId);
    return res.json(completedJob?.result || {
      output: completedJob?.error || 'Chat generation failed.'
    });
  }

  return res.json({
    ok: true,
    pending: true,
    jobId,
    sessionId: sessionId || 'ui_default',
    message: 'Code generation job started'
  });
};

app.post('/chat', ...userAccess, handlePostChat);
app.post('/api/chat', ...userAccess, handlePostChat);

// ─── CHAT JOB STATUS ENDPOINT (Polling) ───────────────────────────────────
const handleGetChatJobStatus = async (req, res) => {
  const jobId = req.params.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  let job = activeJobs.get(jobId);
  if (!job) {
    const dbRow = await dbGet(`SELECT * FROM llm_jobs WHERE job_id = ?`, [jobId]);
    if (dbRow) {
      job = {
        jobId: dbRow.job_id,
        userId: dbRow.user_id,
        sessionId: dbRow.session_id,
        status: dbRow.status,
        startTime: new Date(dbRow.created_at).getTime(),
        result: dbRow.result_json ? JSON.parse(dbRow.result_json) : null,
        error: dbRow.error_text || null
      };
    }
  }

  if (!job) {
    return res.status(404).json({ error: 'Job not found', jobId });
  }

  return res.json({
    ok: true,
    jobId: job.jobId,
    status: job.status,
    elapsed_ms: Date.now() - job.startTime,
    result: job.result,
    error: job.error
  });
};

app.get('/chat/job/:jobId', ...userAccess, handleGetChatJobStatus);
app.get('/api/chat/job/:jobId', ...userAccess, handleGetChatJobStatus);

// ─── CHAT HISTORY ─────────────────────────────────────────────────────────

app.post('/history', ...userAccess, async (req, res) => {
  try {
    const userId = req.userId;
    const { session_id, role, content } = req.body;

    if (!role || !content) {
      return res.status(400).json({ error: 'role and content required' });
    }

    const sessionKey = session_id || 'default';

    // Check if conversation execution is blocked (locked/deleted)
    const blockCheck = await checkConversationBlocked(userId, sessionKey);
    if (blockCheck.blocked) {
      return res.status(403).json({ error: `Conversation Messaging Blocked: this session is ${blockCheck.reason}` });
    }

    // Count history check to see if this initializes the conversation
    const countRow = await dbGet(
      'SELECT COUNT(*) AS count FROM chat_history WHERE session_id = ? AND user_id = ?',
      [sessionKey, userId]
    );
    const isNewConversation = (countRow?.count || 0) === 0;

    await dbRun(
      `INSERT INTO chat_history (session_id, user_id, role, content)
       VALUES (?, ?, ?, ?)`,
      [sessionKey, userId, role, content]
    );

    // Sync conversation metadata to database
    await syncSingleConversation(userId, sessionKey);

    if (isNewConversation) {
      // Track activity (Phase 4)
      trackActivity({
        activityType: 'CONVERSATION_CREATED',
        resourceType: 'conversation',
        resourceId: sessionKey,
        resourceName: sessionKey
      });
    }

    res.json({ ok: true });
  } catch (err) {
    sendRouteError(res, err);
  }
});


app.get('/history', ...userAccess, async (req, res) => {
  try {
    const userId = req.userId;
    const session_id = req.query.session_id || 'default';

    const rows = await dbAll(
      `SELECT role, content, created_at FROM chat_history
       WHERE user_id = ? AND session_id = ?
       ORDER BY created_at ASC`,
      [userId, session_id]
    );

    const conv = await dbGet('SELECT status, deleted_at FROM conversations WHERE user_id = ? AND session_id = ? ORDER BY id DESC', [userId, session_id]);
    if (conv && conv.deleted_at) {
      return res.json({ status: 'deleted', messages: [] });
    }
    const status = conv ? conv.status : 'active';

    res.json({ status, messages: rows });
  } catch (err) {
    sendRouteError(res, err);
  }
});
// GET /user/admin-messages/status
app.get('/user/admin-messages/status', ...userAccess, async (req, res) => {
  try {
    const userId = req.userId;

    // Get unread counts
    const unreadCount = await dbGet(`
      SELECT COUNT(*) as count
      FROM admin_message_receipts
      WHERE user_id = ? AND status IN ('SENT', 'DELIVERED')
    `, [userId]);

    // Automatically mark SENT as DELIVERED since the client is polling
    const sentMessages = await dbAll(`
      SELECT message_id FROM admin_message_receipts
      WHERE user_id = ? AND status = 'SENT'
    `, [userId]);

    if (sentMessages && sentMessages.length > 0) {
      await dbRun(`
        UPDATE admin_message_receipts
        SET status = 'DELIVERED', delivered_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status = 'SENT'
      `, [userId]);

      for (const msg of sentMessages) {
        await auditLog({
          action: 'ADMIN_MESSAGE_DELIVERED',
          actorId: userId,
          targetType: 'message',
          targetId: msg.message_id,
          metadata: { userId }
        }).catch(e => console.error('[Audit Error]', e));
      }
    }

    const convSync = await dbAll('SELECT session_id, status FROM conversations WHERE user_id = ? AND status IN ("deleted", "locked")', [userId]);
    const deletedConvs = convSync.filter(c => c.status === 'deleted').map(c => c.session_id);
    const lockedConvs = convSync.filter(c => c.status === 'locked').map(c => c.session_id);

    const activeConvs = await dbAll('SELECT session_id, message_count FROM conversations WHERE user_id = ? AND status = "active" AND deleted_at IS NULL', [userId]);

    res.json({
      ok: true,
      unreadCount: unreadCount ? unreadCount.count : 0,
      deletedConvs,
      lockedConvs,
      activeConvs
    });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// POST /user/admin-messages/read
app.post('/user/admin-messages/read', ...userAccess, async (req, res) => {
  try {
    const userId = req.userId;

    const unreadMessages = await dbAll(`
      SELECT message_id FROM admin_message_receipts
      WHERE user_id = ? AND status IN ('SENT', 'DELIVERED')
    `, [userId]);

    if (unreadMessages && unreadMessages.length > 0) {
      await dbRun(`
        UPDATE admin_message_receipts
        SET status = 'READ', read_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND status IN ('SENT', 'DELIVERED')
      `, [userId]);

      for (const msg of unreadMessages) {
        await auditLog({
          action: 'ADMIN_MESSAGE_READ',
          actorId: userId,
          targetType: 'message',
          targetId: msg.message_id,
          metadata: { userId }
        }).catch(e => console.error('[Audit Error]', e));
      }

      // Track user activity
      trackActivity({
        userId,
        activityType: 'ADMIN_MESSAGE_VIEWED',
        resourceType: 'conversation',
        resourceId: 'admin_msg_' + userId,
        resourceName: 'Administration Messages'
      });
    }

    res.json({ ok: true });
  } catch (err) {
    sendRouteError(res, err);
  }
});


app.delete('/history', ...userAccess, async (req, res) => {
  try {
    const userId = req.userId;
    const session_id = req.query.session_id || 'default';

    await dbRun(
      `DELETE FROM chat_history WHERE user_id = ? AND session_id = ?`,
      [userId, session_id]
    );

    // Sync conversation table (removes/soft-deletes)
    await syncSingleConversation(userId, session_id);

    // Soft-delete the conversation→project link if one exists
    await unlinkConversationProject(userId, session_id);

    // Log conversation deletion (Phase 2)
    await auditLog({
      action: 'CONVERSATION_DELETED',
      targetType: 'conversation',
      targetId: session_id
    });

    // Track activity (Phase 4)
    trackActivity({
      activityType: 'CONVERSATION_DELETED',
      resourceType: 'conversation',
      resourceId: session_id,
      resourceName: session_id
    });

    res.json({ ok: true });
  } catch (err) {
    sendRouteError(res, err);
  }
});

// ─── CONVERSATION PROJECT API ─────────────────────────────────────────────────

/**
 * GET /conversation-project
 * Returns the project linked to the active conversation session (passed as query param).
 * Used by the n8n workflow to determine whether to enter EDIT or CREATE mode.
 *
 * Query: ?session_id=<sessionId>
 */
app.get('/conversation-project', ...userAccess, async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    if (!sessionId) return res.status(400).json({ error: 'session_id query param required' });

    const includeFiles = req.query.include_files === 'true' || req.query.include_files === '1';
    const project = await getConversationProject(req.userId, sessionId, includeFiles);
    if (!project) {
      return res.json({ has_project: false, project: null });
    }
    return res.json({ has_project: true, project });
  } catch (err) {
    sendRouteError(res, err);
  }
});

/**
 * POST /conversation-project
 * Explicitly link or update a project for a conversation.
 * Called by the n8n workflow after successfully saving a project.
 *
 * Body: { session_id, program_name, project_type, language, entry_file, packages }
 */
app.post('/conversation-project', ...userAccess, async (req, res) => {
  try {
    const { session_id, program_name, project_type, language, entry_file, packages, root_directory } = req.body;
    if (!session_id || !program_name) {
      return res.status(400).json({ error: 'session_id and program_name are required' });
    }

    const result = await linkConversationProject(req.userId, session_id, {
      program_name,
      project_type: project_type || 'single_file',
      language:     language     || null,
      entry_file:   entry_file   || null,
      root_directory: root_directory || null,
      packages:     packages     || []
    });

    await auditLog({
      action: 'CONVERSATION_PROJECT_LINKED',
      targetType: 'conversation',
      targetId: session_id,
      newValue: program_name
    });

    res.json({ ok: true, project: result });
  } catch (err) {
    sendRouteError(res, err);
  }
});

/**
 * GET /conversation-projects
 * Returns all conversation→project mappings for the current user.
 * Used by the frontend sidebar to show project names on conversation cards.
 */
app.get('/conversation-projects', ...userAccess, async (req, res) => {
  try {
    const projects = await getAllConversationProjects(req.userId);
    res.json(projects);
  } catch (err) {
    sendRouteError(res, err);
  }
});

// Log AI LLM call usage and cost (Phase 8)
app.post('/api/ai/log', ...userAccess, async (req, res) => {
  try {
    const { provider, model, input_tokens, output_tokens, latency_ms, success, error } = req.body;

    if (!provider || !model) {
      return res.status(400).json({ error: 'provider and model are required' });
    }

    const result = await trackLlmRequest({
      userId: req.userId,
      provider,
      model,
      inputTokens: input_tokens,
      outputTokens: output_tokens,
      latencyMs: latency_ms,
      success,
      error
    });

    if (result.success) {
      res.json({ ok: true, estimated_cost: result.estimatedCost });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (err) {
    sendRouteError(res, err);
  }
});


app.get('/n8n-health', async (req, res) => {
  try {
    const r = await fetch(process.env.N8N_HEALTH_URL || 'http://localhost:5678/webhook/health');
    const data = await r.json();

    const isOnline = Array.isArray(data)
      ? data[0]?.status === 'ok'
      : data?.status === 'ok';

    res.json({ status: isOnline });

  } catch {
    res.json({ status: false });
  }
});

// ─── START ────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║         IPEM Execution Agent Running                     ║
  ║   Port    : ${PORT}                                         ║
  ║                                                          ║
  ║   Endpoints:                                             ║
  ║   POST /save          → Save generated code              ║
  ║   POST /execute       → Run program (non-interactive)    ║
  ║   POST /execute/start → Start interactive session        ║
  ║   POST /execute/input → Send input to session            ║
  ║   POST /execute/stop  → Stop a session                   ║
  ║   GET  /programs      → List all programs                ║
  ║   GET  /last-program  → Get last generated               ║
  ║   GET  /memory        → Read facts                       ║
  ║   POST /memory        → Update facts                     ║
  ╚══════════════════════════════════════════════════════════╝
  `);

  // Run startup program sync
  syncPrograms().catch(err => {
    console.error('Failed to run startup program sync:', err);
  });

  // Run startup conversation sync
  syncConversations().catch(err => {
    console.error('Failed to run startup conversation sync:', err);
  });

  // Start system infrastructure health monitoring daemon
  startMonitoringDaemon();
});

// Configure Node HTTP Server timeouts to prevent socket termination during long-running code generations (e.g. Ollama local models)
server.timeout = 900000; // 15 minutes
server.keepAliveTimeout = 120000; // 2 minutes keep-alive
server.headersTimeout = 125000; // slightly greater than keepAliveTimeout
