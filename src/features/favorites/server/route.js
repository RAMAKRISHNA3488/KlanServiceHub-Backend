import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/favorites/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const favorites = db.prepare(`
      SELECT f.*, 
             p.name as project_name, p.key as project_key
      FROM user_favorites f
      LEFT JOIN projects p ON f.entity_type = 'PROJECT' AND f.entity_id = p.id
      WHERE f.user_id = ? AND f.workspace_id = ?
      ORDER BY f.created_at DESC
    `).all(user.$id, workspaceId);

    return ctx.json({ data: favorites.map(formatDoc) });
  })
  .post('/favorites/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { entityType, entityId } = await ctx.req.json();

    if (!entityType || !entityId) return ctx.json({ error: 'entityType and entityId are required.' }, 400);

    const favId = randomUUID();
    db.prepare(`
      INSERT INTO user_favorites (id, user_id, workspace_id, entity_type, entity_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, entity_type, entity_id) DO NOTHING
    `).run(favId, user.$id, workspaceId, entityType, entityId);

    return ctx.json({ success: true, id: favId });
  })
  .delete('/favorites/item/:favoriteId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { favoriteId } = ctx.req.param();

    db.prepare('DELETE FROM user_favorites WHERE id = ? AND user_id = ?').run(favoriteId, user.$id);
    return ctx.json({ success: true });
  })
  .get('/recent-items/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();

    const recent = db.prepare(`
      SELECT * FROM user_recent_items
      WHERE user_id = ? AND workspace_id = ?
      ORDER BY viewed_at DESC
      LIMIT 20
    `).all(user.$id, workspaceId);

    return ctx.json({ data: recent.map(formatDoc) });
  })
  .post('/recent-items/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { entityType, entityId, title, subtitle = '' } = await ctx.req.json();

    if (!entityType || !entityId || !title) return ctx.json({ error: 'entityType, entityId, and title are required.' }, 400);

    const itemId = randomUUID();
    db.prepare(`
      INSERT INTO user_recent_items (id, user_id, workspace_id, entity_type, entity_id, title, subtitle)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(itemId, user.$id, workspaceId, entityType, entityId, title, subtitle);

    return ctx.json({ success: true, id: itemId });
  });

export default app;
