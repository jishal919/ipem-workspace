//agent\src\sessionManager.js
const Redis = require('ioredis');

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryStrategy: (times) => {
    // Stop retrying after 3 attempts to allow fallback
    if (times > 3) return null;
    return Math.min(times * 50, 2000);
  }
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err.message);
});

const SESSION_PREFIX = 'ipem:session:';

async function saveSessionMetadata(session_id, data) {
  try {
    await redis.set(`${SESSION_PREFIX}${session_id}`, JSON.stringify(data), 'EX', 3600); // 1 hour expiry
  } catch (err) {
    console.warn('Failed to save session metadata to Redis:', err.message);
  }
}

async function getSessionMetadata(session_id) {
  try {
    const data = await redis.get(`${SESSION_PREFIX}${session_id}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    console.warn('Failed to get session metadata from Redis:', err.message);
    return null;
  }
}

async function listAllSessions() {
  try {
    const keys = await redis.keys(`${SESSION_PREFIX}*`);
    const sessions = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (data) sessions.push(JSON.parse(data));
    }
    return sessions;
  } catch (err) {
    console.warn('Failed to list sessions from Redis:', err.message);
    return [];
  }
}

async function clearAllSessionMetadata() {
  try {
    const keys = await redis.keys(`${SESSION_PREFIX}*`);
    if (keys.length === 0) return 0;
    await redis.del(...keys);
    return keys.length;
  } catch (err) {
    console.warn('Failed to clear session metadata from Redis:', err.message);
    return 0;
  }
}

async function deleteSessionMetadata(session_id) {
  try {
    await redis.del(`${SESSION_PREFIX}${session_id}`);
  } catch (err) {
    console.warn('Failed to delete session metadata from Redis:', err.message);
  }
}

module.exports = {
  redis,
  saveSessionMetadata,
  getSessionMetadata,
  listAllSessions,
  clearAllSessionMetadata,
  deleteSessionMetadata
};
