import { db, getD1Database } from '../db.js';

/**
 * Checks if a user has a specific permission in a workspace.
 * Company Owner automatically has full accessibility (all permissions).
 */
export async function hasPermission({ workspaceId, userId, permissionCode }) {
  if (!workspaceId || !userId) return false;
  const d1 = getD1Database();

  // 1. Check if user is the Company Profile Owner (Full Unrestricted Access)
  let workspace = null;
  if (d1) {
    try {
      workspace = await d1.prepare('SELECT user_id FROM workspaces WHERE id = ?').bind(workspaceId).first();
    } catch (e) {}
  }
  if (!workspace) {
    workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
  }
  if (workspace && workspace.user_id === userId) {
    return true;
  }

  // 2. Check if user has an active membership
  let member = null;
  if (d1) {
    try {
      member = await d1.prepare('SELECT status, role, organization_role FROM members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
    } catch (e) {}
  }
  if (!member) {
    member = db.prepare('SELECT status, role, organization_role FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  }

  if (!member || member.status === 'SUSPENDED') {
    return false;
  }

  // If Legacy ADMIN, Company Owner, or Company Admin role, treat as unrestricted admin
  if (member.role === 'ADMIN' || member.organization_role === 'COMPANY_OWNER' || member.organization_role === 'COMPANY_ADMIN') {
    return true;
  }

  // 3. Query role permissions through user_roles -> role_permissions
  let perm = null;
  if (d1) {
    try {
      perm = await d1.prepare(`
        SELECT rp.permission_code
        FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        WHERE ur.workspace_id = ? AND ur.user_id = ? AND rp.permission_code = ?
        LIMIT 1
      `).bind(workspaceId, userId, permissionCode).first();
    } catch (e) {}
  }
  if (!perm) {
    perm = db.prepare(`
      SELECT rp.permission_code
      FROM user_roles ur
      JOIN role_permissions rp ON ur.role_id = rp.role_id
      WHERE ur.workspace_id = ? AND ur.user_id = ? AND rp.permission_code = ?
      LIMIT 1
    `).get(workspaceId, userId, permissionCode);
  }

  return !!perm;
}

/**
 * Get all effective permissions for a user in a workspace
 */
export async function getUserPermissions({ workspaceId, userId }) {
  if (!workspaceId || !userId) return [];
  const d1 = getD1Database();

  let workspace = null;
  if (d1) {
    try {
      workspace = await d1.prepare('SELECT user_id FROM workspaces WHERE id = ?').bind(workspaceId).first();
    } catch (e) {}
  }
  if (!workspace) {
    workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
  }
  const isOwner = workspace && workspace.user_id === userId;

  if (isOwner) {
    let allPerms = [];
    if (d1) {
      try {
        const res = await d1.prepare('SELECT code FROM permissions').all();
        allPerms = res?.results || [];
      } catch (e) {}
    }
    if (allPerms.length === 0) {
      allPerms = db.prepare('SELECT code FROM permissions').all();
    }
    return allPerms.map((p) => p.code);
  }

  let member = null;
  if (d1) {
    try {
      member = await d1.prepare('SELECT status, role, organization_role FROM members WHERE workspace_id = ? AND user_id = ?').bind(workspaceId, userId).first();
    } catch (e) {}
  }
  if (!member) {
    member = db.prepare('SELECT status, role, organization_role FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  }
  if (!member || member.status === 'SUSPENDED') {
    return [];
  }

  if (member.role === 'ADMIN' || member.organization_role === 'COMPANY_OWNER' || member.organization_role === 'COMPANY_ADMIN') {
    let allPerms = [];
    if (d1) {
      try {
        const res = await d1.prepare('SELECT code FROM permissions').all();
        allPerms = res?.results || [];
      } catch (e) {}
    }
    if (allPerms.length === 0) {
      allPerms = db.prepare('SELECT code FROM permissions').all();
    }
    return allPerms.map((p) => p.code);
  }

  let perms = [];
  if (d1) {
    try {
      const res = await d1.prepare(`
        SELECT DISTINCT rp.permission_code
        FROM user_roles ur
        JOIN role_permissions rp ON ur.role_id = rp.role_id
        WHERE ur.workspace_id = ? AND ur.user_id = ?
      `).bind(workspaceId, userId).all();
      perms = res?.results || [];
    } catch (e) {}
  }
  if (perms.length === 0) {
    perms = db.prepare(`
      SELECT DISTINCT rp.permission_code
      FROM user_roles ur
      JOIN role_permissions rp ON ur.role_id = rp.role_id
      WHERE ur.workspace_id = ? AND ur.user_id = ?
    `).all(workspaceId, userId);
  }

  return perms.map((p) => p.permission_code);
}

/**
 * Hono Middleware to require specific permission code
 */
export function requirePermission(permissionCode) {
  return async (ctx, next) => {
    const user = ctx.get('user');
    const workspaceId = ctx.req.param('workspaceId') || ctx.req.query('workspaceId');

    if (!user) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    if (!workspaceId) {
      return ctx.json({ error: 'Workspace context is required.' }, 400);
    }

    const permitted = await hasPermission({
      workspaceId,
      userId: user.$id,
      permissionCode,
    }, ctx.env?.DB);

    if (!permitted) {
      return ctx.json({ error: `Forbidden: Missing required permission ${permissionCode}` }, 403);
    }

    await next();
  };
}
