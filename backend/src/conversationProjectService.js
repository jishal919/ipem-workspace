// agent/src/conversationProjectService.js
// ── ONE CONVERSATION = ONE PROJECT ──────────────────────────────────────────
// This service enforces the architectural rule that each conversation session
// owns at most one project. Once a session creates a project, all subsequent
// code requests inside that session modify the EXISTING project rather than
// creating a new directory.
//
// The conversation_projects table is the source of truth. It stores:
//   - program_name     : the folder name on disk
//   - project_type     : single_file | static_html | node | flask | fastapi
//   - language         : detected language
//   - entry_file       : main entry point
//   - root_directory   : absolute path on disk
//   - packages         : JSON array of installed packages
//   - project_created  : when the project was first created
//   - last_modified    : when the project was last touched
//   - project_status   : active | archived | deleted

const { dbAll, dbRun, dbGet } = require('./database');
const { getProjectFilesWithContent, readProjectMeta } = require('./projectManager');

/**
 * Get the project linked to a conversation session.
 * Returns null if this conversation has no project yet.
 *
 * @param {number} userId
 * @param {string} sessionId
 * @param {boolean} [includeFiles=false]
 * @returns {Promise<object|null>}
 */
async function getConversationProject(userId, sessionId, includeFiles = false) {
  try {
    const row = await dbGet(
      `SELECT * FROM conversation_projects
       WHERE user_id = ? AND session_id = ? AND project_status != 'deleted'`,
      [userId, sessionId]
    );
    if (!row) return null;

    const result = {
      program_name:    row.program_name,
      project_type:    row.project_type    || 'single_file',
      language:        row.language        || null,
      entry_file:      row.entry_file      || null,
      root_directory:  row.root_directory  || null,
      packages:        safeParseJson(row.packages, []),
      project_created: row.project_created,
      last_modified:   row.last_modified,
      project_status:  row.project_status
    };

    if (includeFiles) {
      result.files = await getProjectFilesWithContent(userId, row.program_name);
      const meta = await readProjectMeta(userId, row.program_name);
      if (meta) {
        if (meta.entry_file && !result.entry_file) result.entry_file = meta.entry_file;
        if (meta.project_type && !result.project_type) result.project_type = meta.project_type;
        if (meta.original_request) result.original_request = meta.original_request;
      }
    }

    return result;
  } catch (err) {
    console.error('[CONV PROJECT SERVICE] getConversationProject error:', err);
    return null;
  }
}

/**
 * Link a project to a conversation. Call this AFTER the project files have
 * been successfully saved to disk.
 *
 * - If the session has NO linked project yet  → creates the link.
 * - If the session ALREADY has a linked project → updates only the metadata
 *   fields (project_type, language, entry_file, packages, last_modified).
 *   The program_name is NEVER changed after first creation.
 *
 * @param {number} userId
 * @param {string} sessionId
 * @param {object} projectInfo
 * @param {string} projectInfo.program_name
 * @param {string} [projectInfo.project_type]
 * @param {string} [projectInfo.language]
 * @param {string} [projectInfo.entry_file]
 * @param {string} [projectInfo.root_directory]
 * @param {string[]} [projectInfo.packages]
 * @returns {Promise<object>} The saved record
 */
async function linkConversationProject(userId, sessionId, projectInfo) {
  try {
    const {
      program_name,
      project_type   = 'single_file',
      language       = null,
      entry_file     = null,
      root_directory = null,
      packages       = []
    } = projectInfo;

    if (!program_name) throw new Error('program_name is required');

    const existing = await dbGet(
      `SELECT id, program_name FROM conversation_projects
       WHERE user_id = ? AND session_id = ?`,
      [userId, sessionId]
    );

    const packagesJson = JSON.stringify(Array.isArray(packages) ? packages : []);
    const now = new Date().toISOString();

    if (!existing) {
      // First project for this conversation — create the binding
      await dbRun(
        `INSERT INTO conversation_projects
           (user_id, session_id, program_name, project_type, language, entry_file,
            root_directory, packages, project_created, last_modified, project_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
        [userId, sessionId, program_name, project_type, language, entry_file,
         root_directory, packagesJson, now, now]
      );
      console.log(
        `[CONV PROJECT SERVICE] Linked new project: user=${userId}, session=${sessionId}, program=${program_name}`
      );
    } else {
      // Conversation already owns a project — update metadata only.
      // The program_name (directory) is NEVER changed.
      await dbRun(
        `UPDATE conversation_projects
         SET project_type   = ?,
             language       = ?,
             entry_file     = ?,
             root_directory = ?,
             packages       = ?,
             last_modified  = ?,
             project_status = 'active'
         WHERE user_id = ? AND session_id = ?`,
        [project_type, language, entry_file, root_directory, packagesJson, now, userId, sessionId]
      );
      console.log(
        `[CONV PROJECT SERVICE] Updated project metadata: user=${userId}, session=${sessionId}, program=${existing.program_name}`
      );
    }

    return await getConversationProject(userId, sessionId);
  } catch (err) {
    console.error('[CONV PROJECT SERVICE] linkConversationProject error:', err);
    throw err;
  }
}

/**
 * Check whether a conversation already owns a project.
 * Returns the project record or null.
 *
 * @param {number} userId
 * @param {string} sessionId
 * @returns {Promise<object|null>}
 */
async function getProjectForConversation(userId, sessionId) {
  return getConversationProject(userId, sessionId);
}

/**
 * Soft-delete the conversation project link (does NOT touch the actual files).
 * Used when a conversation is deleted.
 *
 * @param {number} userId
 * @param {string} sessionId
 */
async function unlinkConversationProject(userId, sessionId) {
  try {
    await dbRun(
      `UPDATE conversation_projects
       SET project_status = 'deleted', last_modified = ?
       WHERE user_id = ? AND session_id = ?`,
      [new Date().toISOString(), userId, sessionId]
    );
  } catch (err) {
    console.error('[CONV PROJECT SERVICE] unlinkConversationProject error:', err);
  }
}

/**
 * Get all conversations that own projects for a user.
 * Used to populate the sidebar with project name badges.
 *
 * @param {number} userId
 * @returns {Promise<Array<{session_id, program_name, project_type, language, last_modified}>>}
 */
async function getAllConversationProjects(userId) {
  try {
    return await dbAll(
      `SELECT session_id, program_name, project_type, language, last_modified
       FROM conversation_projects
       WHERE user_id = ? AND project_status = 'active'
       ORDER BY last_modified DESC`,
      [userId]
    );
  } catch (err) {
    console.error('[CONV PROJECT SERVICE] getAllConversationProjects error:', err);
    return [];
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function safeParseJson(str, fallback) {
  try {
    return JSON.parse(str || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

module.exports = {
  getConversationProject,
  linkConversationProject,
  getProjectForConversation,
  unlinkConversationProject,
  getAllConversationProjects
};
