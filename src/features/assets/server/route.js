import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc, logActivity } from '../../../db.js';

let tablesEnsured = false;
async function ensureAssetsTables(d1) {
  if (!d1) return;
  try {
    await d1Run(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'SERVER',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        owner_id TEXT,
        environment TEXT DEFAULT 'PRODUCTION',
        location TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        uptime_percent REAL DEFAULT 100.0,
        provider TEXT DEFAULT '',
        version TEXT DEFAULT '',
        metadata TEXT DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    await d1Run(`
      CREATE TABLE IF NOT EXISTS service_dependencies (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        source_asset_id TEXT NOT NULL,
        target_asset_id TEXT NOT NULL,
        relationship TEXT DEFAULT 'depends on',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `, [], d1);

    // Ensure columns exist on older schemas
    const alterColumns = [
      'ALTER TABLE assets ADD COLUMN ip_address TEXT DEFAULT ""',
      'ALTER TABLE assets ADD COLUMN uptime_percent REAL DEFAULT 100.0',
      'ALTER TABLE assets ADD COLUMN provider TEXT DEFAULT ""',
      'ALTER TABLE assets ADD COLUMN version TEXT DEFAULT ""',
      'ALTER TABLE assets ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP'
    ];
    for (const sql of alterColumns) {
      try {
        await d1Run(sql, [], d1);
      } catch (e) {
        // Column already exists, safe to ignore
      }
    }
    tablesEnsured = true;
  } catch (err) {
    console.error('ensureAssetsTables error:', err);
  }
}

const app = new Hono()
  // 1. List assets for workspace
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    const assets = await d1All(`
      SELECT 
        a.*, 
        u.name as owner_name,
        (SELECT COUNT(*) FROM service_dependencies sd WHERE sd.source_asset_id = a.id) as upstream_deps_count,
        (SELECT COUNT(*) FROM service_dependencies sd WHERE sd.target_asset_id = a.id) as downstream_deps_count
      FROM assets a
      LEFT JOIN users u ON a.owner_id = u.id
      WHERE a.workspace_id = ?
      ORDER BY 
        CASE a.status 
          WHEN 'OFFLINE' THEN 1 
          WHEN 'DEGRADED' THEN 2 
          WHEN 'MAINTENANCE' THEN 3 
          ELSE 4 
        END,
        a.name ASC
    `, [workspaceId], d1);

    return ctx.json({ data: assets.map(formatDoc) });
  })

  // 2. Topology graph & telemetry stats
  .get('/:workspaceId/topology', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    const assets = await d1All(`
      SELECT a.*, u.name as owner_name
      FROM assets a
      LEFT JOIN users u ON a.owner_id = u.id
      WHERE a.workspace_id = ?
      ORDER BY a.name ASC
    `, [workspaceId], d1);

    const deps = await d1All(`
      SELECT 
        d.id, d.workspace_id, d.source_asset_id, d.target_asset_id, d.relationship,
        sa.name as source_name, sa.type as source_type, sa.status as source_status,
        ta.name as target_name, ta.type as target_type, ta.status as target_status
      FROM service_dependencies d
      JOIN assets sa ON d.source_asset_id = sa.id
      JOIN assets ta ON d.target_asset_id = ta.id
      WHERE d.workspace_id = ?
    `, [workspaceId], d1);

    const totalNodes = assets.length;
    const healthyCount = assets.filter(a => a.status === 'ACTIVE').length;
    const degradedCount = assets.filter(a => a.status === 'DEGRADED').length;
    const maintenanceCount = assets.filter(a => a.status === 'MAINTENANCE').length;
    const offlineCount = assets.filter(a => a.status === 'OFFLINE').length;
    const totalEdges = deps.length;

    const avgUptime = totalNodes > 0
      ? (assets.reduce((sum, a) => sum + (Number(a.uptime_percent) || 99.95), 0) / totalNodes).toFixed(2)
      : '100.00';

    return ctx.json({
      data: {
        nodes: assets.map(formatDoc),
        edges: deps.map(formatDoc),
        stats: {
          totalNodes,
          healthyCount,
          degradedCount,
          maintenanceCount,
          offlineCount,
          totalEdges,
          avgUptime: Number(avgUptime),
          healthyPercent: totalNodes > 0 ? Math.round((healthyCount / totalNodes) * 100) : 100
        }
      }
    });
  })

  // 3. Register a new Configuration Item / Asset
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const {
      name,
      type = 'SERVER',
      status = 'ACTIVE',
      environment = 'PRODUCTION',
      location = '',
      ip_address = '',
      provider = '',
      version = '',
      uptime_percent = null,
      metadata = {}
    } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    if (!name || !name.trim()) {
      return ctx.json({ error: 'Asset name is required.' }, 400);
    }

    const id = randomUUID();
    const cleanName = name.trim();
    const metaStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

    const finalUptime = uptime_percent !== null && uptime_percent !== undefined
      ? Number(uptime_percent)
      : (status.toUpperCase() === 'ACTIVE' ? 100.0 : (status.toUpperCase() === 'DEGRADED' ? 98.0 : (status.toUpperCase() === 'MAINTENANCE' ? 95.0 : 0.0)));

    await d1Run(`
      INSERT INTO assets (
        id, workspace_id, name, type, status, owner_id, 
        environment, location, ip_address, uptime_percent, 
        provider, version, metadata, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      id, workspaceId, cleanName, type.toUpperCase(), status.toUpperCase(), user.$id,
      environment.toUpperCase(), location, ip_address, finalUptime,
      provider, version, metaStr
    ], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Member',
      action: 'REGISTERED_ASSET',
      targetId: id,
      targetName: cleanName,
      details: `Registered ${type} configuration item "${cleanName}" (${environment})`,
    }, d1);

    return ctx.json({
      success: true,
      data: {
        id,
        name: cleanName,
        type: type.toUpperCase(),
        status: status.toUpperCase(),
        environment: environment.toUpperCase(),
        location,
        ip_address,
        uptime_percent
      },
    }, 201);
  })

  // 4. Update asset status or metadata
  .patch('/:workspaceId/:assetId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, assetId } = ctx.req.param();
    const body = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    const asset = await d1First(`SELECT * FROM assets WHERE id = ? AND workspace_id = ?`, [assetId, workspaceId], d1);
    if (!asset) return ctx.json({ error: 'Asset not found.' }, 404);

    const name = body.name !== undefined ? body.name.trim() : asset.name;
    const type = body.type !== undefined ? body.type.toUpperCase() : asset.type;
    const status = body.status !== undefined ? body.status.toUpperCase() : asset.status;
    const environment = body.environment !== undefined ? body.environment.toUpperCase() : asset.environment;
    const location = body.location !== undefined ? body.location : asset.location;
    const ip_address = body.ip_address !== undefined ? body.ip_address : asset.ip_address;
    const provider = body.provider !== undefined ? body.provider : asset.provider;
    const version = body.version !== undefined ? body.version : asset.version;
    const uptime_percent = body.uptime_percent !== undefined ? Number(body.uptime_percent) : asset.uptime_percent;
    const metadata = body.metadata !== undefined 
      ? (typeof body.metadata === 'string' ? body.metadata : JSON.stringify(body.metadata)) 
      : asset.metadata;

    await d1Run(`
      UPDATE assets SET
        name = ?, type = ?, status = ?, environment = ?,
        location = ?, ip_address = ?, provider = ?, version = ?,
        uptime_percent = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND workspace_id = ?
    `, [name, type, status, environment, location, ip_address, provider, version, uptime_percent, metadata, assetId, workspaceId], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Member',
      action: 'UPDATED_ASSET',
      targetId: assetId,
      targetName: name,
      details: `Updated CI ${name} to status ${status}`,
    }, d1);

    return ctx.json({
      success: true,
      data: {
        id: assetId,
        name,
        type,
        status,
        environment,
        location,
        ip_address,
        uptime_percent
      }
    });
  })

  // 5. Delete asset and associated dependencies
  .delete('/:workspaceId/:assetId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId, assetId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    const asset = await d1First(`SELECT name FROM assets WHERE id = ? AND workspace_id = ?`, [assetId, workspaceId], d1);
    if (!asset) return ctx.json({ error: 'Asset not found.' }, 404);

    // Delete dependencies referencing this asset
    await d1Run(`DELETE FROM service_dependencies WHERE source_asset_id = ? OR target_asset_id = ?`, [assetId, assetId], d1);
    await d1Run(`DELETE FROM assets WHERE id = ? AND workspace_id = ?`, [assetId, workspaceId], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Member',
      action: 'DELETED_ASSET',
      targetId: assetId,
      targetName: asset.name,
      details: `Decommissioned CI "${asset.name}" and removed all linked topology dependencies`,
    }, d1);

    return ctx.json({ success: true, message: 'Asset successfully decommissioned.' });
  })

  // 6. List service dependencies
  .get('/:workspaceId/dependencies', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    const deps = await d1All(`
      SELECT 
        d.*, 
        sa.name as source_name, sa.type as source_type, sa.status as source_status, sa.environment as source_env,
        ta.name as target_name, ta.type as target_type, ta.status as target_status, ta.environment as target_env
      FROM service_dependencies d
      JOIN assets sa ON d.source_asset_id = sa.id
      JOIN assets ta ON d.target_asset_id = ta.id
      WHERE d.workspace_id = ?
      ORDER BY d.created_at DESC
    `, [workspaceId], d1);

    return ctx.json({ data: deps.map(formatDoc) });
  })

  // 7. Add service dependency link
  .post('/:workspaceId/dependencies', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { sourceAssetId, targetAssetId, relationship = 'depends on' } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    if (!sourceAssetId || !targetAssetId) {
      return ctx.json({ error: 'sourceAssetId and targetAssetId are required.' }, 400);
    }
    if (sourceAssetId === targetAssetId) {
      return ctx.json({ error: 'An asset cannot depend directly on itself.' }, 400);
    }

    // Verify both assets exist
    const [source, target] = await Promise.all([
      d1First(`SELECT name FROM assets WHERE id = ? AND workspace_id = ?`, [sourceAssetId, workspaceId], d1),
      d1First(`SELECT name FROM assets WHERE id = ? AND workspace_id = ?`, [targetAssetId, workspaceId], d1),
    ]);

    if (!source || !target) {
      return ctx.json({ error: 'Source or Target asset not found in this workspace.' }, 404);
    }

    // Check duplicate
    const existing = await d1First(`
      SELECT id FROM service_dependencies 
      WHERE workspace_id = ? AND source_asset_id = ? AND target_asset_id = ?
    `, [workspaceId, sourceAssetId, targetAssetId], d1);

    if (existing) {
      return ctx.json({ error: 'This dependency relationship already exists.' }, 409);
    }

    const id = randomUUID();
    await d1Run(`
      INSERT INTO service_dependencies (id, workspace_id, source_asset_id, target_asset_id, relationship)
      VALUES (?, ?, ?, ?, ?)
    `, [id, workspaceId, sourceAssetId, targetAssetId, relationship], d1);

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Member',
      action: 'CREATED_DEPENDENCY',
      targetId: id,
      targetName: `${source.name} ➔ ${target.name}`,
      details: `Linked dependency: [${source.name}] ${relationship} [${target.name}]`,
    }, d1);

    return ctx.json({ success: true, id }, 201);
  })

  // 8. Delete service dependency link
  .delete('/:workspaceId/dependencies/:depId', sessionMiddleware, async (ctx) => {
    const { workspaceId, depId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    await d1Run(`DELETE FROM service_dependencies WHERE id = ? AND workspace_id = ?`, [depId, workspaceId], d1);
    return ctx.json({ success: true, message: 'Dependency link removed.' });
  })

  // 9. Seed realistic sample enterprise infrastructure topology
  .post('/:workspaceId/seed-sample', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    await ensureAssetsTables(d1);

    // Clean existing assets & dependencies for clean seed
    await d1Run(`DELETE FROM service_dependencies WHERE workspace_id = ?`, [workspaceId], d1);
    await d1Run(`DELETE FROM assets WHERE workspace_id = ?`, [workspaceId], d1);

    const sampleNodes = [
      {
        id: randomUUID(),
        name: 'Cloudflare Global CDN & WAF',
        type: 'CLOUD_RESOURCE',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'Global Anycast Edge',
        ip_address: '104.16.89.201',
        uptime_percent: 100.0,
        provider: 'Cloudflare',
        version: 'Edge v2.4'
      },
      {
        id: randomUUID(),
        name: 'Kong API Gateway & Load Balancer',
        type: 'API_GATEWAY',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS us-east-1 (EKS)',
        ip_address: '10.0.1.15',
        uptime_percent: 99.99,
        provider: 'AWS',
        version: 'v3.5.0'
      },
      {
        id: randomUUID(),
        name: 'Authentication & SSO Service',
        type: 'APPLICATION',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS us-east-1 (EKS)',
        ip_address: '10.0.2.10',
        uptime_percent: 99.98,
        provider: 'AWS',
        version: 'v2.1.4'
      },
      {
        id: randomUUID(),
        name: 'KSM ITSM & Core Services Engine',
        type: 'APPLICATION',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS us-east-1 (EKS)',
        ip_address: '10.0.2.25',
        uptime_percent: 99.95,
        provider: 'AWS',
        version: 'v1.12.0'
      },
      {
        id: randomUUID(),
        name: 'Billing & Payment Webhook Worker',
        type: 'APPLICATION',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'Cloudflare Workers',
        ip_address: '10.0.2.40',
        uptime_percent: 99.99,
        provider: 'Cloudflare',
        version: 'v1.0.8'
      },
      {
        id: randomUUID(),
        name: 'Redis Distributed Cache (Primary)',
        type: 'CACHE',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS us-east-1 (ElastiCache)',
        ip_address: '10.0.3.50',
        uptime_percent: 99.99,
        provider: 'AWS',
        version: 'v7.2'
      },
      {
        id: randomUUID(),
        name: 'Kafka Real-Time Event Bus',
        type: 'QUEUE',
        status: 'DEGRADED',
        environment: 'PRODUCTION',
        location: 'Confluent Cloud (AWS)',
        ip_address: '10.0.3.85',
        uptime_percent: 99.82,
        provider: 'Confluent',
        version: 'v3.6.1'
      },
      {
        id: randomUUID(),
        name: 'PostgreSQL Primary D1 Cluster',
        type: 'DATABASE',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS RDS Multi-AZ',
        ip_address: '10.0.4.100',
        uptime_percent: 99.99,
        provider: 'AWS',
        version: 'pg-16.1'
      },
      {
        id: randomUUID(),
        name: 'PostgreSQL Read Replica (EU-West)',
        type: 'DATABASE',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'AWS eu-west-1',
        ip_address: '10.0.4.105',
        uptime_percent: 99.95,
        provider: 'AWS',
        version: 'pg-16.1'
      },
      {
        id: randomUUID(),
        name: 'Cloudflare R2 Artifact Storage',
        type: 'CLOUD_RESOURCE',
        status: 'ACTIVE',
        environment: 'PRODUCTION',
        location: 'Global Object Store',
        ip_address: '172.67.12.8',
        uptime_percent: 100.0,
        provider: 'Cloudflare',
        version: 'S3-Compat'
      }
    ];

    for (const node of sampleNodes) {
      await d1Run(`
        INSERT INTO assets (
          id, workspace_id, name, type, status, owner_id,
          environment, location, ip_address, uptime_percent,
          provider, version, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        node.id, workspaceId, node.name, node.type, node.status, user.$id,
        node.environment, node.location, node.ip_address, node.uptime_percent,
        node.provider, node.version
      ], d1);
    }

    const [cdn, kong, auth, ksm, billing, redis, kafka, dbMaster, dbReplica, r2] = sampleNodes;

    const sampleEdges = [
      { src: cdn.id, tgt: kong.id, rel: 'routes traffic to' },
      { src: kong.id, tgt: auth.id, rel: 'routes traffic to' },
      { src: kong.id, tgt: ksm.id, rel: 'routes traffic to' },
      { src: kong.id, tgt: billing.id, rel: 'routes traffic to' },
      { src: auth.id, tgt: redis.id, rel: 'reads from' },
      { src: auth.id, tgt: dbMaster.id, rel: 'depends on' },
      { src: ksm.id, tgt: redis.id, rel: 'reads from' },
      { src: ksm.id, tgt: dbMaster.id, rel: 'depends on' },
      { src: ksm.id, tgt: kafka.id, rel: 'writes to' },
      { src: billing.id, tgt: dbMaster.id, rel: 'depends on' },
      { src: billing.id, tgt: r2.id, rel: 'reads from' },
      { src: dbMaster.id, tgt: dbReplica.id, rel: 'replicates to' },
    ];

    for (const edge of sampleEdges) {
      const edgeId = randomUUID();
      await d1Run(`
        INSERT INTO service_dependencies (id, workspace_id, source_asset_id, target_asset_id, relationship)
        VALUES (?, ?, ?, ?, ?)
      `, [edgeId, workspaceId, edge.src, edge.tgt, edge.rel], d1);
    }

    await logActivity({
      workspaceId,
      actorId: user.$id,
      actorName: user.name || 'Member',
      action: 'SEEDED_TOPOLOGY',
      targetId: workspaceId,
      targetName: 'CMDB Topology',
      details: 'Provisioned enterprise multi-tier infrastructure topology with 10 CIs and 12 dependencies',
    }, d1);

    return ctx.json({
      success: true,
      message: 'Enterprise infrastructure topology seeded successfully.',
      nodesCount: sampleNodes.length,
      edgesCount: sampleEdges.length
    });
  });

export default app;
