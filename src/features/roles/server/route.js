import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, SYSTEM_PERMISSIONS, d1All, d1First, d1Run } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const roles = await d1All(`
      SELECT * FROM roles 
      WHERE workspace_id = ?
      ORDER BY is_system DESC, created_at ASC
    `, [workspaceId]);

    const rolesWithPerms = await Promise.all(
      roles.map(async (role) => {
        const perms = await d1All(`
          SELECT permission_code FROM role_permissions WHERE role_id = ?
        `, [role.id]);

        const countRow = await d1First(`
          SELECT COUNT(*) as c FROM user_roles WHERE role_id = ?
        `, [role.id]);

        return {
          ...formatDoc(role),
          permissions: perms.map((p) => p.permission_code),
          userCount: countRow?.c || 0,
        };
      })
    );

    return ctx.json({
      data: {
        roles: rolesWithPerms,
        allPermissions: SYSTEM_PERMISSIONS,
      },
    });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', permissions = [] } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'ROLE_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing ROLE_MANAGE permission.' }, 403);
    }

    if (!name) {
      return ctx.json({ error: 'Role name is required.' }, 400);
    }

    const existing = await d1First('SELECT id FROM roles WHERE workspace_id = ? AND name = ?', [workspaceId, name]);
    if (existing) {
      return ctx.json({ error: 'A role with this name already exists in this workspace.' }, 400);
    }

    const roleId = randomUUID();
    await d1Run(`
      INSERT INTO roles (id, workspace_id, name, description, is_system)
      VALUES (?, ?, ?, ?, 0)
    `, [roleId, workspaceId, name, description]);

    for (const code of permissions) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [roleId, code]);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_ROLE',
      entityType: 'ROLE',
      entityId: roleId,
      details: { name, permissionsCount: permissions.length },
    });

    return ctx.json({ data: { id: roleId, name, description, permissions } });
  })
  .put('/:workspaceId/:roleId/permissions', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, roleId } = ctx.req.param();
    const { permissions = [] } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'ROLE_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing ROLE_MANAGE permission.' }, 403);
    }

    const role = await d1First('SELECT * FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId]);
    if (!role) {
      return ctx.json({ error: 'Role not found.' }, 404);
    }

    if (role.name === 'Company Owner') {
      return ctx.json({ error: 'Company Owner permissions cannot be modified.' }, 400);
    }

    // Delete existing permissions for this role
    await d1Run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);

    for (const code of permissions) {
      await d1Run(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `, [roleId, code]);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_ROLE_PERMISSIONS',
      entityType: 'ROLE',
      entityId: roleId,
      details: `Updated permissions for ${role.name}: ${permissions.join(', ')}`,
    });

    return ctx.json({ success: true, permissions });
  })
  .delete('/:workspaceId/:roleId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, roleId } = ctx.req.param();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'ROLE_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing ROLE_MANAGE permission.' }, 403);
    }

    const role = await d1First('SELECT * FROM roles WHERE id = ? AND workspace_id = ?', [roleId, workspaceId]);
    if (!role) {
      return ctx.json({ error: 'Role not found.' }, 404);
    }

    if (role.is_system) {
      return ctx.json({ error: 'System roles cannot be deleted.' }, 400);
    }

    await d1Run('DELETE FROM roles WHERE id = ?', [roleId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'DELETE_ROLE',
      entityType: 'ROLE',
      entityId: roleId,
      details: `Deleted role ${role.name}`,
    });

    return ctx.json({ success: true });
  });

export default app;
