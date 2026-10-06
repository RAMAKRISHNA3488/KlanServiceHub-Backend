import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1Run, getD1Database, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const assets = await d1All(`
      SELECT a.*, u.name as owner_name
      FROM assets a
      LEFT JOIN users u ON a.owner_id = u.id
      WHERE a.workspace_id = ?
      ORDER BY a.name ASC
    `, [workspaceId], d1);

    return ctx.json({ data: assets.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, type = 'SERVER', environment = 'PRODUCTION', location = 'AWS us-east-1', metadata = {} } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!name) return ctx.json({ error: 'Asset name is required.' }, 400);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO assets (id, workspace_id, name, type, status, owner_id, environment, location, metadata)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)
    `, [id, workspaceId, name, type, user.$id, environment, location, JSON.stringify(metadata)], d1);

    return ctx.json({
      success: true,
      data: {
        id,
        name,
        type,
        environment,
      },
    });
  })
  .get('/:workspaceId/dependencies', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const deps = await d1All(`
      SELECT d.*, sa.name as source_asset, ta.name as target_asset, sa.type as source_type, ta.type as target_type
      FROM service_dependencies d
      JOIN assets sa ON d.source_asset_id = sa.id
      JOIN assets ta ON d.target_asset_id = ta.id
      WHERE d.workspace_id = ?
    `, [workspaceId], d1);

    return ctx.json({ data: deps.map(formatDoc) });
  })
  .post('/:workspaceId/dependencies', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { sourceAssetId, targetAssetId, relationship = 'depends on' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!sourceAssetId || !targetAssetId) return ctx.json({ error: 'sourceAssetId and targetAssetId are required.' }, 400);

    const id = randomUUID();
    await d1Run(`
      INSERT INTO service_dependencies (id, workspace_id, source_asset_id, target_asset_id, relationship)
      VALUES (?, ?, ?, ?, ?)
    `, [id, workspaceId, sourceAssetId, targetAssetId, relationship], d1);

    return ctx.json({ success: true, id });
  });

export default app;
