import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { db, formatDoc } from '../db.js';
import { AUTH_COOKIE } from '../features/auth/constants.js';

export const sessionMiddleware = createMiddleware(async (ctx, next) => {
  const authHeader = ctx.req.header('authorization') || ctx.req.header('Authorization');
  const bearerToken = authHeader?.replace(/^[Bb]earer\s+/i, '')?.trim();
  const sessionSecret = getCookie(ctx, AUTH_COOKIE) || bearerToken;

  if (!sessionSecret) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  let session = null;
  let user = null;

  // Try Cloudflare D1 first if available
  if (ctx.env?.DB) {
    try {
      session = await ctx.env.DB.prepare(`
        SELECT * FROM sessions WHERE secret = ? AND datetime(expires_at) > datetime('now')
      `).bind(sessionSecret).first();

      if (session) {
        user = await ctx.env.DB.prepare(`
          SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?
        `).bind(session.user_id).first();
      }
    } catch (e) {
      console.error('[D1_SESSION_MIDDLEWARE_ERROR]:', e);
    }
  }

  // Fallback to local db if not found in D1
  if (!session) {
    const querySession = db.prepare(`
      SELECT * FROM sessions WHERE secret = ? AND datetime(expires_at) > datetime('now')
    `);
    session = querySession.get(sessionSecret);

    if (session) {
      const queryUser = db.prepare(`
        SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?
      `);
      user = queryUser.get(session.user_id);
    }
  }

  if (!session || !user) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  ctx.set('user', formatDoc(user));
  ctx.set('session', session);

  await next();
});

