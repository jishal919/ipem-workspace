const { exec, spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const Docker = require('dockerode');
const pty = require('node-pty');
const { USE_DOCKER, DOCKER_IMAGES } = require('./config');
const { LANGUAGES, isInstalled, installLanguage, detectLanguageFromFilename } = require('./languages');
const { saveSessionMetadata, deleteSessionMetadata, listAllSessions } = require('./sessionManager');
const { getUserGeneratedRoot, readProjectMeta } = require('./projectManager');
const { ensureUserStorage, writeJsonFileSafe } = require('./userStorage');

const docker = new Docker();
const activeSessions = {};

// Patterns that indicate a web server has started and bound to a port.
// Order matters: more specific patterns first.
const PORT_PATTERNS = [
  // Flask/FastAPI: " * Running on http://127.0.0.1:5000"
  /running on https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0):(\d{2,5})/i,
  // Uvicorn/Gunicorn: "Uvicorn running on http://0.0.0.0:8000"
  /uvicorn running on https?:\/\/[^:]+:(\d{2,5})/i,
  // Express/Node: "Listening on http://localhost:3000" or "Server listening on port 3000"
  /listening on (?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):?(\d{2,5})/i,
  // Generic: "Server started on port 8080" / "running on port 3000"
  /(?:server|app) (?:started|running|listening)(?: on)?(?: port)?\s+(\d{2,5})/i,
  // Vite/Next.js: "Local:   http://localhost:5173"
  /local:\s+https?:\/\/localhost:(\d{2,5})/i,
  // http-server: "Available on: http://127.0.0.1:8080"
  /available on:\s+https?:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/i,
  // Fallback: any "localhost:PORT" or "127.0.0.1:PORT" in stdout
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})/i,
];

// Ports that belong to IPEM infrastructure — never proxy to these.
const RESERVED_PORTS = new Set([9000, 4000, 3000, 22, 80, 443, 8080]);

function createDeletedFileError() {
  const err = new Error('Execution failed because the file was removed.');
  err.code = 'FILE_DELETED';
  err.status = 404;
  return err;
}

async function ensureExecutableFileExists(userId, program_name, filename) {
  const generatedRoot = await getUserGeneratedRoot(userId);
  const programDir = path.join(generatedRoot, program_name || '');
  const filePath = path.join(programDir, filename || '');

  if (!program_name || !filename || !fs.existsSync(filePath)) {
    throw createDeletedFileError();
  }

  return { programDir, filePath };
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

function isWaitingForInput(data) {
  const clean = stripAnsi(data).trimEnd();
  return (
    clean.endsWith(':') ||
    clean.endsWith('?') ||
    clean.endsWith('>') ||
    clean.endsWith('> ') ||
    /:\s*$/.test(clean) ||
    /\?\s*$/.test(clean) ||
    clean.includes('Enter ') ||
    clean.includes('enter ') ||
    clean.includes('Input ') ||
    clean.includes('input ') ||
    clean.includes('Type ') ||
    clean.includes('type ') ||
    clean.includes('Password') ||
    clean.includes('password')
  );
}

async function runInDocker(userId, lang, program_name, filename, timeout) {
  const image = DOCKER_IMAGES[lang];
  if (!image) throw new Error(`No Docker image configured for ${lang}`);

  const programDir = path.join(await getUserGeneratedRoot(userId), program_name);
  const hostPath = path.resolve(programDir);
  const containerWorkDir = '/usr/src/app';

  let cmd = [];
  if (lang === 'python') cmd = ['python', filename];
  else if (lang === 'javascript') cmd = ['node', filename];
  else if (lang === 'typescript') cmd = ['npx', 'ts-node', filename];

  try {
    const container = await docker.createContainer({
      Image: image,
      Cmd: cmd,
      WorkingDir: containerWorkDir,
      HostConfig: {
        Binds: lang === 'python'
          ? [
              `${hostPath}:${containerWorkDir}`,
              `${path.resolve(__dirname, 'sitecustomize.py')}:${containerWorkDir}/sitecustomize.py:ro`
            ]
          : [`${hostPath}:${containerWorkDir}`],
        AutoRemove: true,
        NetworkMode: 'none',
        Memory: 512 * 1024 * 1024,
        NanoCpus: 1000000000
      },
      Tty: false
    });

    const stream = await container.attach({ stream: true, stdout: true, stderr: true });
    let stdout = '';
    let stderr = '';

    docker.modem.demuxStream(stream, {
      write: (data) => { stdout += data.toString(); }
    }, {
      write: (data) => { stderr += data.toString(); }
    });

    await container.start();

    const waitPromise = container.wait();
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Execution timed out')), timeout)
    );
    const result = await Promise.race([waitPromise, timeoutPromise]);

    return {
      stdout,
      stderr,
      exitCode: result.StatusCode !== undefined ? result.StatusCode : 0,
      status: result.StatusCode === 0 ? 'SUCCESS' : 'ERROR'
    };
  } catch (err) {
    return { stdout: '', stderr: err.message, exitCode: 1, status: 'ERROR' };
  }
}

function getExecutionCommand(lang, programDir, filePath) {
  if (lang === 'python') {
    const venvDir = path.join(programDir, 'venv');
    if (fs.existsSync(venvDir)) {
      const pythonExe = process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python')
        : path.join(venvDir, 'bin', 'python');
      return `"${pythonExe}" "${filePath}"`;
    }
  }
  return LANGUAGES[lang].run(filePath);
}

function getSpawnCommand(lang, programDir) {
  if (lang === 'python') {
    const venvDir = path.join(programDir, 'venv');
    if (fs.existsSync(venvDir)) {
      return process.platform === 'win32'
        ? path.join(venvDir, 'Scripts', 'python')
        : path.join(venvDir, 'bin', 'python');
    }
  }
  return LANGUAGES[lang].spawn;
}

async function preparePythonEnvironment(lang, programDir) {
  const env = { ...process.env };
  if (lang === 'python') {
    const sharedSiteCustomizeDir = path.resolve(__dirname);
    const paths = [programDir, sharedSiteCustomizeDir];
    if (env.PYTHONPATH) {
      paths.push(env.PYTHONPATH);
    }
    env.PYTHONPATH = paths.join(path.delimiter);
  }
  return env;
}

async function executeProgram(userId, program_name, filename, timeout = 60000) {
  const { programDir, filePath } = await ensureExecutableFileExists(userId, program_name, filename);
  const { generatedLogsRoot } = await ensureUserStorage(userId);

  const lang = detectLanguageFromFilename(filename);
  if (!lang) throw new Error(`Unsupported file type: ${path.extname(filename)}`);

  if (USE_DOCKER && DOCKER_IMAGES[lang]) {
    const result = await runInDocker(userId, lang, program_name, filename, timeout);
    const log = { program_name, filename, language: lang, timestamp: new Date().toISOString(), ...result };
    await writeJsonFileSafe(path.join(generatedLogsRoot, `${program_name}_${Date.now()}.log`), log);
    return log;
  }

  if (!isInstalled(lang)) await installLanguage(lang);

  const env = await preparePythonEnvironment(lang, programDir);
  const command = getExecutionCommand(lang, programDir, filePath);
  await fsp.mkdir(generatedLogsRoot, { recursive: true });
  const logFile = path.join(generatedLogsRoot, `${program_name}_${Date.now()}.log`);

  return new Promise((resolve) => {
    exec(command, { timeout, cwd: programDir, env }, (error, stdout, stderr) => {
      const log = {
        program_name,
        filename,
        language: lang,
        timestamp: new Date().toISOString(),
        stdout: stdout || '',
        stderr: stderr || '',
        exitCode: error ? error.code : 0,
        status: error ? 'ERROR' : 'SUCCESS'
      };
      fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
      resolve(log);
    });
  });
}

function updateSessionRedis(session_id) {
  const session = activeSessions[session_id];
  if (!session) return;

  saveSessionMetadata(session_id, {
    session_id,
    user_id: session.user_id,
    program_name: session.program_name,
    filename: session.filename,
    language: session.language,
    running: session.running,
    status: session.status,
    startTime: session.startTime,
    waiting_for_input: session.isWaiting(),
    output: session.getOutput()
  });
}

async function startInteractiveSession(userId, program_name, filename) {
  const { programDir, filePath } = await ensureExecutableFileExists(userId, program_name, filename);

  const lang = detectLanguageFromFilename(filename);
  if (!lang) throw new Error('Unsupported file type');
  if (!isInstalled(lang)) await installLanguage(lang);

  const session_id = `session_${Date.now()}`;
  const spawnCmd = getSpawnCommand(lang, programDir);

  let outputBuffer = '';
  let waitingForInput = false;
  let detectedPort = null;

  const env = await preparePythonEnvironment(lang, programDir);
  const spawnArgs = lang === 'python' ? ['-u', filePath] : [filePath];
  const childProcess = spawn(spawnCmd, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: programDir,
    env
  });

  function scanForPort(text) {
    if (detectedPort) return; // already found a port
    for (const pattern of PORT_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port >= 1024 && port <= 65535 && !RESERVED_PORTS.has(port)) {
          detectedPort = port;
          updateSessionRedis(session_id);
          break;
        }
      }
    }
  }

  childProcess.stdout.on('data', (data) => {
    const text = data.toString();
    outputBuffer += text;
    scanForPort(text);
    if (isWaitingForInput(text)) waitingForInput = true;
    updateSessionRedis(session_id);
  });

  childProcess.stderr.on('data', (data) => {
    const text = data.toString();
    outputBuffer += text;
    // Some frameworks (Flask dev server) write port info to stderr
    scanForPort(text);
    updateSessionRedis(session_id);
  });

  childProcess.on('close', (code) => {
    if (!activeSessions[session_id]) return;
    const session = activeSessions[session_id];
    session.running = false;
    session.status = code === 0 ? 'SUCCESS' : 'ERROR';
    updateSessionRedis(session_id);

    // Update DB stats for interactive run
    const durationMs = Date.now() - new Date(session.startTime).getTime();
    const isSuccess = code === 0;

    const { updateProgramExecutionStats } = require('./programService');
    updateProgramExecutionStats(session.user_id, session.program_name, isSuccess, durationMs).catch(err => {
      console.error('[EXECUTOR] Failed to update stats on close:', err);
    });

    setTimeout(() => {
      delete activeSessions[session_id];
      deleteSessionMetadata(session_id);
    }, 30000);
  });

  activeSessions[session_id] = {
    childProcess,
    isPty: false,
    user_id: userId,
    program_name,
    filename,
    language: lang,
    running: true,
    status: 'RUNNING',
    startTime: new Date().toISOString(),
    getOutput: () => outputBuffer,
    getError: () => '',
    clearOutput: () => { outputBuffer = ''; },
    isWaiting: () => waitingForInput,
    resetWaiting: () => { waitingForInput = false; },
    getDetectedPort: () => detectedPort
  };

  updateSessionRedis(session_id);
  return { session_id, lang, outputBuffer, waitingForInput, filename };
}

function sendInputToSession(session_id, input, userId) {
  const session = activeSessions[session_id];
  if (!session || session.user_id !== userId) {
    throw new Error('Session not found or already closed');
  }

  if (!session.running) {
    return {
      session_id,
      status: session.status,
      output: session.getOutput(),
      error: session.getError(),
      program_finished: true,
      message: 'Program has already finished'
    };
  }

  session.clearOutput();
  session.resetWaiting();

  if (session.isPty) session.childProcess.write(input + '\r');
  else session.childProcess.stdin.write(input + '\n');

  updateSessionRedis(session_id);
  return { session_id, status: 'RUNNING' };
}

function stopSession(session_id, userId) {
  const session = activeSessions[session_id];
  if (!session || session.user_id !== userId) {
    throw new Error('Session not found');
  }

  if (session.isPty) session.childProcess.kill();
  else session.childProcess.kill('SIGTERM');

  session.running = false;
  session.status = 'CANCELLED';
  updateSessionRedis(session_id);
  delete activeSessions[session_id];
  deleteSessionMetadata(session_id);
  return { status: 'CANCELLED', session_id };
}

async function listSessions(userId) {
  const localSessions = Object.entries(activeSessions)
    .filter(([, session]) => session.user_id === userId)
    .map(([id, session]) => ({
      session_id: id,
      program_name: session.program_name,
      filename: session.filename,
      language: session.language,
      status: session.status,
      running: session.running,
      startTime: session.startTime,
      waiting_for_input: session.isWaiting()
    }));

  if (localSessions.length > 0) return localSessions;

  await listAllSessions();
  return [];
}

function getSession(session_id, userId) {
  const session = activeSessions[session_id];
  if (!session || session.user_id !== userId) return null;
  return session;
}

function invalidateSessionsForDeletedTarget(userId, program_name, filename = null) {
  const invalidated = [];

  Object.entries(activeSessions).forEach(([session_id, session]) => {
    if (session.user_id !== userId) return;

    const sameProgram = session.program_name === program_name;
    const sameFile = !filename || session.filename === filename;
    if (!sameProgram || !sameFile) return;

    try {
      if (session.isPty) session.childProcess.kill();
      else session.childProcess.kill('SIGTERM');
    } catch (_) {}

    session.running = false;
    session.status = 'FILE_DELETED';
    invalidated.push(session_id);
    updateSessionRedis(session_id);
    delete activeSessions[session_id];
    deleteSessionMetadata(session_id);
  });

  return invalidated;
}

/**
 * Returns preview metadata for a session if a server port was detected.
 * @param {string} session_id
 * @param {number} userId
 * @returns {{ type: string, port: number, url: string } | null}
 */
function getPreviewInfo(session_id, userId) {
  const session = activeSessions[session_id];
  if (!session || session.user_id !== userId) return null;
  const port = session.getDetectedPort();
  if (!port) return null;
  return { type: 'server', port, previewPath: `/preview/port/${port}/` };
}

/**
 * Returns true if the given port belongs to an active session owned by userId.
 * Used as a security gate before proxying preview requests.
 * @param {number} port
 * @param {number} userId
 * @returns {boolean}
 */
function isPortOwnedByUser(port, userId) {
  return Object.values(activeSessions).some(
    (s) => s.user_id === userId && s.getDetectedPort() === port
  );
}

/**
 * Project-type-aware execution entry point.
 *
 * Reads project_meta.json from the program directory and routes:
 *   - static_html  → immediate preview URL (no process spawned)
 *   - node/flask/fastapi/server types → startInteractiveSession
 *   - single_file  → executeProgram (existing batch path)
 *
 * Falls back to legacy single-file behaviour if no meta is found.
 *
 * @param {number} userId
 * @param {string} programName
 * @param {number} [timeout=60000]
 * @returns {Promise<object>}  Execution result or preview descriptor
 */
async function executeByProjectType(userId, programName, timeout = 60000) {
  const meta = await readProjectMeta(userId, programName);

  // Determine if it is a static HTML project
  let isStaticHtml = false;
  let entryFile = 'index.html';

  if (meta) {
    if (meta.project_type === 'static_html' || meta.language === 'html' || (meta.entry_file && meta.entry_file.endsWith('.html'))) {
      isStaticHtml = true;
      entryFile = meta.entry_file || 'index.html';
    }
  }

  // Fallback detection 1: check directory contents for .html files
  const { getSafeProgramDir } = require('./projectManager');
  let programDir;
  try {
    const dirResult = await getSafeProgramDir(userId, programName);
    programDir = dirResult.programDir;
    const files = await fsp.readdir(programDir);
    const htmlFiles = files.filter(f => f.endsWith('.html'));
    if (htmlFiles.length > 0) {
      isStaticHtml = true;
      entryFile = htmlFiles.includes('index.html') ? 'index.html' : htmlFiles[0];
    }
  } catch (e) {}

  // Fallback detection 2: read entry file contents to see if it is HTML
  if (!isStaticHtml && programDir) {
    try {
      const { resolveProgramAndFile } = require('./projectManager');
      const resolved = await resolveProgramAndFile(userId, programName, null);
      if (resolved && resolved.filename) {
        const filePath = path.join(programDir, resolved.filename);
        const content = await fsp.readFile(filePath, 'utf8');
        const trimmed = content.trim().toLowerCase();
        if (trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || resolved.filename.endsWith('.html')) {
          isStaticHtml = true;
          entryFile = resolved.filename;
        }
      }
    } catch (e) {}
  }

  // ── 1. Static HTML / CSS / JS website ─────────────────────────────────────
  if (isStaticHtml) {
    const previewUrl = `/preview/html/${encodeURIComponent(programName)}/`;
    return {
      program_name: programName,
      project_type: 'static_html',
      entry_file:   entryFile,
      status:       'SUCCESS',
      preview:      true,
      preview_url:  previewUrl,
      stdout:       '',
      stderr:       '',
      exitCode:     0
    };
  }

  // ── 2. Server-type projects (interactive session with port detection) ──────
  const SERVER_TYPES = ['node', 'express', 'flask', 'fastapi', 'react', 'vue'];
  if (meta && SERVER_TYPES.includes(meta.project_type)) {
    const entryFile = meta.entry_file;
    if (!entryFile) {
      throw new Error(`project_meta.json for "${programName}" has no entry_file`);
    }
    return startInteractiveSession(userId, programName, entryFile);
  }

  // ── 3. Single-file (Python, JS, etc.) or legacy (no meta) ─────────────────
  if (meta && meta.entry_file) {
    return executeProgram(userId, programName, meta.entry_file, timeout);
  }

  // Legacy fallback: resolve the primary runnable file from disk
  const { resolveProgramAndFile } = require('./projectManager');
  const resolved = await resolveProgramAndFile(userId, programName, null);
  return executeProgram(userId, programName, resolved.filename, timeout);
}

module.exports = {
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
};
