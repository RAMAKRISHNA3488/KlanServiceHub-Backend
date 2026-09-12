import { db } from '../db.js';

/**
 * Checks if a user has a specific permission in a workspace.
 * Company Owner automatically has full accessibility (all permissions).
 */
export function hasPermission({ workspaceId, userId, permissionCode }) {
  if (!workspaceId || !userId) return false;

  // 1. Check if user is the Company Profile Owner (Full Unrestricted Access)
  const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
  if (workspace && workspace.user_id === userId) {
    return true;
  }

  // 2. Check if user has an active membership
  const member = db.prepare('SELECT status, role FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  if (!member || member.status === 'SUSPENDED') {
    return false;
  }

  // If Legacy ADMIN role, treat as Company Admin
  if (member.role === 'ADMIN') {
    return true;
  }

  // 3. Query role permissions through user_roles -> role_permissions
  const perm = db.prepare(`
    SELECT rp.permission_code
    FROM user_roles ur
    JOIN role_permissions rp ON ur.role_id = rp.role_id
    WHERE ur.workspace_id = ? AND ur.user_id = ? AND rp.permission_code = ?
    LIMIT 1
  `).get(workspaceId, userId, permissionCode);

  return !!perm;
}

/**
 * Get all effective permissions for a user in a workspace
 */
export function getUserPermissions({ workspaceId, userId }) {
  if (!workspaceId || !userId) return [];

  const workspace = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
  const isOwner = workspace && workspace.user_id === userId;

  if (isOwner) {
    const allPerms = db.prepare('SELECT code FROM permissions').all();
    return allPerms.map((p) => p.code);
  }

  const member = db.prepare('SELECT status, role FROM members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  if (!member || member.status === 'SUSPENDED') {
    return [];
  }

  if (member.role === 'ADMIN') {
    const allPerms = db.prepare('SELECT code FROM permissions').all();
    return allPerms.map((p) => p.code);
  }

  const perms = db.prepare(`
    SELECT DISTINCT rp.permission_code
    FROM user_roles ur
    JOIN role_permissions rp ON ur.role_id = rp.role_id
    WHERE ur.workspace_id = ? AND ur.user_id = ?
  `).all(workspaceId, userId);

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

    const permitted = hasPermission({
      workspaceId,
      userId: user.$id,
      permissionCode,
    });

    if (!permitted) {
      return ctx.json({ error: `Forbidden: Missing required permission ${permissionCode}` }, 403);
    }

    await next();
  };
}
