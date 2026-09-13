import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { db, formatDoc } from '../db.js';
import { AUTH_COOKIE } from '../features/auth/constants.js';

export const sessionMiddleware = createMiddleware(async (ctx, next) => {
  let sessionSecret = getCookie(ctx, AUTH_COOKIE);

  // Fallback to Bearer token or custom session header for cross-origin / mobile clients
  if (!sessionSecret) {
    const authHeader = ctx.req.header('Authorization') || ctx.req.header('authorization');
    if (authHeader && authHeader.startsWith('Bearer ')) {
      sessionSecret = authHeader.slice(7).trim();
    }
  }

  if (!sessionSecret) {
    sessionSecret = ctx.req.header('x-session-token') || ctx.req.header('x-auth-token');
  }

  if (!sessionSecret) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  const querySession = db.prepare(`
    SELECT * FROM sessions WHERE secret = ? AND datetime(expires_at) > datetime('now')
  `);
  const session = querySession.get(sessionSecret);

  if (!session) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  const queryUser = db.prepare(`
    SELECT id, name, email, created_at, updated_at FROM users WHERE id = ?
  `);
  const user = queryUser.get(session.user_id);

  if (!user) {
    return ctx.json({ error: 'Unauthorized.' }, 401);
  }

  ctx.set('user', formatDoc(user));
  ctx.set('session', session);

  await next();
});
