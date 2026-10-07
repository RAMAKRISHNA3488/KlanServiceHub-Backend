import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { db, formatDoc, getD1Database } from '../db.js';
import { AUTH_COOKIE } from '../features/auth/constants.js';

// Lightweight short-lived in-memory session cache (30 seconds) for edge latency reduction
const sessionCache = new Map();
const SESSION_CACHE_TTL_MS = 30 * 1000;

export const sessionMiddleware = createMiddleware(async (ctx, next) => {
  const authHeader = ctx.req.header('authorization') || ctx.req.header('Authorization');
  const bearerToken = authHeader?.replace(/^[Bb]earer\s+/i, '')?.trim();
  const sessionSecret = getCookie(ctx, AUTH_COOKIE) || bearerToken;

  if (!sessionSecret) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  // 1. Check in-memory edge cache
  const cached = sessionCache.get(sessionSecret);
  const now = Date.now();
  if (cached && cached.expiresAtMs > now) {
    ctx.set('user', cached.user);
    ctx.set('session', cached.session);
    return next();
  }

  let session = null;
  let user = null;

  // 2. Try Cloudflare D1 with a single JOIN query (reduces 2 DB roundtrips to 1)
  const activeD1 = ctx.env?.DB || getD1Database();
  if (activeD1) {
    try {
      const combined = await activeD1.prepare(`
        SELECT 
          s.id as session_id, s.user_id, s.secret, s.expires_at,
          u.id as user_id_val, u.name, u.email, u.created_at, u.updated_at
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.secret = ? AND datetime(s.expires_at) > datetime('now')
      `).bind(sessionSecret).first();

      if (combined) {
        session = {
          id: combined.session_id,
          user_id: combined.user_id,
          secret: combined.secret,
          expires_at: combined.expires_at,
        };
        user = {
          id: combined.user_id_val || combined.user_id,
          name: combined.name,
          email: combined.email,
          created_at: combined.created_at,
          updated_at: combined.updated_at,
        };
      }
    } catch (e) {
      console.error('[D1_SESSION_MIDDLEWARE_ERROR]:', e);
    }
  }

  // 3. Fallback to local memory db if not resolved in D1
  if (!session || !user) {
    const querySession = db.prepare(`
      SELECT * FROM sessions WHERE secret = ? AND datetime(expires_at) > datetime('now')
    `);
    const fallbackSession = querySession.get(sessionSecret);

    if (fallbackSession) {
      const queryUser = db.prepare(`
        SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?
      `);
      const fallbackUser = queryUser.get(fallbackSession.user_id);
      if (fallbackUser) {
        session = fallbackSession;
        user = fallbackUser;
      }
    }
  }

  if (!session || !user) {
    sessionCache.delete(sessionSecret);
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  const formattedUser = formatDoc(user);

  // Store in short-lived memory cache
  if (sessionCache.size > 500) {
    sessionCache.clear();
  }
  sessionCache.set(sessionSecret, {
    user: formattedUser,
    session,
    expiresAtMs: now + SESSION_CACHE_TTL_MS,
  });

  ctx.set('user', formattedUser);
  ctx.set('session', session);

  await next();
});

