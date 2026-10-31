const { dbAll, dbRun, dbGet } = require('./database');

async function getConversationStats(userId, sessionId) {
  const stats = await dbGet(`
    SELECT
      COUNT(*) AS msg_count,
      AVG(LENGTH(content)) AS avg_len,
      MIN(created_at) AS first_msg,
      MAX(created_at) AS last_msg
    FROM chat_history
    WHERE user_id = ? AND session_id = ?
  `, [userId, sessionId]);

  if (!stats || stats.msg_count === 0) {
    return null;
  }

  const msgCount = stats.msg_count || 0;
  const avgLen = Math.round(stats.avg_len || 0);
  const firstMsg = stats.first_msg;
  const lastMsg = stats.last_msg;

  // Calculate duration in seconds
  let durationSec = 0;
  if (firstMsg && lastMsg) {
    durationSec = Math.max(0, Math.floor((new Date(lastMsg) - new Date(firstMsg)) / 1000));
  }

  // Get the title (first user message truncated to 50 characters, or session_id fallback)
  const firstUserMsg = await dbGet(`
    SELECT content FROM chat_history
    WHERE user_id = ? AND session_id = ? AND role = 'user'
    ORDER BY created_at ASC LIMIT 1
  `, [userId, sessionId]);

  let title = sessionId.startsWith('admin_msg_') ? 'Administration Messages' : sessionId;
  if (firstUserMsg && firstUserMsg.content) {
    const cleanContent = firstUserMsg.content.replace(/\n/g, ' ').trim();
    title = cleanContent.length > 50 ? cleanContent.substring(0, 47) + '...' : cleanContent;
  }

  return {
    title,
    messageCount: msgCount,
    firstMsg,
    lastMsg,
    averageLength: avgLen,
    durationSeconds: durationSec
  };
}

async function syncConversations() {
  console.log('[CONVERSATION SERVICE] Starting conversation synchronization...');
  try {
    // 1. Get all distinct user_id and session_id from chat_history
    const pairs = await dbAll('SELECT DISTINCT user_id, session_id FROM chat_history');
    const diskConversations = new Set();

    for (const pair of pairs) {
      const { user_id: userId, session_id: sessionId } = pair;
      diskConversations.add(`${userId}:${sessionId}`);

      const stats = await getConversationStats(userId, sessionId);
      if (!stats) continue;

      const existing = await dbGet(
        'SELECT id, title, message_count FROM conversations WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL',
        [userId, sessionId]
      );

      const metadata = JSON.stringify({
        average_length: stats.averageLength,
        conversation_duration: stats.durationSeconds
      });

      if (!existing) {
        // Create new
        await dbRun(`
          INSERT INTO conversations (
            user_id, session_id, title, message_count, created_at, updated_at, last_message_at, status, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `, [
          userId,
          sessionId,
          stats.title,
          stats.messageCount,
          stats.firstMsg,
          stats.lastMsg,
          stats.lastMsg,
          metadata
        ]);
        console.log(`[CONVERSATION SERVICE] Synced new conversation: user=${userId}, session=${sessionId}`);
      } else {
        // Update stats
        await dbRun(`
          UPDATE conversations
          SET
            title = ?,
            message_count = ?,
            last_message_at = ?,
            updated_at = CURRENT_TIMESTAMP,
            metadata_json = ?
          WHERE id = ?
        `, [stats.title, stats.messageCount, stats.lastMsg, metadata, existing.id]);
      }
    }

    // 2. Mark database active conversations missing from chat_history as deleted
    const dbActive = await dbAll('SELECT id, user_id, session_id FROM conversations WHERE deleted_at IS NULL');
    for (const dbConv of dbActive) {
      const key = `${dbConv.user_id}:${dbConv.session_id}`;
      if (!diskConversations.has(key)) {
        await dbRun(
          "UPDATE conversations SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?",
          [dbConv.id]
        );
        console.log(`[CONVERSATION SERVICE] Soft-deleted empty conversation: user=${dbConv.user_id}, session=${dbConv.session_id}`);
      }
    }

    console.log('[CONVERSATION SERVICE] Conversation synchronization complete.');
  } catch (err) {
    console.error('[CONVERSATION SERVICE] syncConversations error:', err);
  }
}

async function syncSingleConversation(userId, sessionId) {
  try {
    const stats = await getConversationStats(userId, sessionId);
    if (!stats) {
      // If no messages left, soft delete it
      await dbRun(
        "UPDATE conversations SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL",
        [userId, sessionId]
      );
      return null;
    }

    const existing = await dbGet(
      'SELECT id FROM conversations WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL',
      [userId, sessionId]
    );

    const metadata = JSON.stringify({
      average_length: stats.averageLength,
      conversation_duration: stats.durationSeconds
    });

    if (!existing) {
      await dbRun(`
        INSERT INTO conversations (
          user_id, session_id, title, message_count, created_at, updated_at, last_message_at, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
      `, [
        userId,
        sessionId,
        stats.title,
        stats.messageCount,
        stats.firstMsg,
        stats.lastMsg,
        stats.lastMsg,
        metadata
      ]);
      return await dbGet('SELECT * FROM conversations WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL', [userId, sessionId]);
    } else {
      await dbRun(`
        UPDATE conversations
        SET
          title = ?,
          message_count = ?,
          last_message_at = ?,
          updated_at = CURRENT_TIMESTAMP,
          metadata_json = ?
        WHERE id = ?
      `, [stats.title, stats.messageCount, stats.lastMsg, metadata, existing.id]);
      return await dbGet('SELECT * FROM conversations WHERE id = ?', [existing.id]);
    }
  } catch (err) {
    console.error('[CONVERSATION SERVICE] syncSingleConversation error:', err);
    return null;
  }
}

async function checkConversationBlocked(userId, sessionId) {
  const row = await dbGet(
    'SELECT status FROM conversations WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL',
    [userId, sessionId]
  );
  if (!row) {
    return { blocked: false }; // Allow starting new conversations
  }

  if (row.status === 'locked') {
    return { blocked: true, reason: 'locked' };
  }
  if (row.status === 'deleted') {
    return { blocked: true, reason: 'deleted' };
  }

  return { blocked: false };
}

module.exports = {
  syncConversations,
  syncSingleConversation,
  checkConversationBlocked
};
