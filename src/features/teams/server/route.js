import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, d1All, d1First, d1Run } from '../../../db.js';
import { hasPermission } from '../../../lib/permissions.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();

    const teams = await d1All(`
      SELECT 
        t.*,
        u.name as lead_name,
        u.email as lead_email,
        u.avatar_url as lead_avatar
      FROM teams t
      LEFT JOIN users u ON t.lead_id = u.id
      WHERE t.workspace_id = ?
      ORDER BY t.created_at ASC
    `, [workspaceId]);

    const teamList = await Promise.all(
      teams.map(async (team) => {
        const members = await d1All(`
          SELECT u.id, u.name, u.email, u.avatar_url, u.job_title
          FROM team_members tm
          JOIN users u ON tm.user_id = u.id
          WHERE tm.team_id = ?
        `, [team.id]);

        const projects = await d1All(`
          SELECT p.id, p.name, p.image_url
          FROM team_projects tp
          JOIN projects p ON tp.project_id = p.id
          WHERE tp.team_id = ?
        `, [team.id]);

        return {
          ...formatDoc(team),
          lead: team.lead_id ? { id: team.lead_id, name: team.lead_name, email: team.lead_email, avatarUrl: team.lead_avatar } : null,
          members,
          projects,
          memberCount: members.length,
          projectCount: projects.length,
        };
      })
    );

    return ctx.json({ data: teamList });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId } = ctx.req.param();
    const { name, description = '', leadId = null, memberIds = [], projectIds = [] } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'TEAM_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing TEAM_MANAGE permission.' }, 403);
    }

    if (!name) {
      return ctx.json({ error: 'Team name is required.' }, 400);
    }

    const teamId = randomUUID();
    await d1Run(`
      INSERT INTO teams (id, workspace_id, name, description, lead_id)
      VALUES (?, ?, ?, ?, ?)
    `, [teamId, workspaceId, name, description, leadId]);

    // Add members
    for (const userId of memberIds) {
      await d1Run(`
        INSERT OR IGNORE INTO team_members (id, team_id, user_id)
        VALUES (?, ?, ?)
      `, [randomUUID(), teamId, userId]);
    }

    // Add projects
    for (const projId of projectIds) {
      await d1Run(`
        INSERT OR IGNORE INTO team_projects (team_id, project_id)
        VALUES (?, ?)
      `, [teamId, projId]);
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'CREATE_TEAM',
      entityType: 'TEAM',
      entityId: teamId,
      details: { name, membersCount: memberIds.length },
    });

    return ctx.json({ data: { id: teamId, name, description } });
  })
  .patch('/:workspaceId/:teamId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, teamId } = ctx.req.param();
    const { name, description, leadId, memberIds, projectIds } = await ctx.req.json();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'TEAM_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing TEAM_MANAGE permission.' }, 403);
    }

    const team = await d1First('SELECT * FROM teams WHERE id = ? AND workspace_id = ?', [teamId, workspaceId]);
    if (!team) {
      return ctx.json({ error: 'Team not found.' }, 404);
    }

    await d1Run(`
      UPDATE teams 
      SET name = COALESCE(?, name),
          description = COALESCE(?, description),
          lead_id = COALESCE(?, lead_id),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [name ?? null, description ?? null, leadId ?? null, teamId]);

    if (Array.isArray(memberIds)) {
      await d1Run('DELETE FROM team_members WHERE team_id = ?', [teamId]);
      for (const uid of memberIds) {
        await d1Run('INSERT OR IGNORE INTO team_members (id, team_id, user_id) VALUES (?, ?, ?)', [randomUUID(), teamId, uid]);
      }
    }

    if (Array.isArray(projectIds)) {
      await d1Run('DELETE FROM team_projects WHERE team_id = ?', [teamId]);
      for (const pid of projectIds) {
        await d1Run('INSERT OR IGNORE INTO team_projects (team_id, project_id) VALUES (?, ?)', [teamId, pid]);
      }
    }

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'UPDATE_TEAM',
      entityType: 'TEAM',
      entityId: teamId,
      details: `Updated team ${name || team.name}`,
    });

    return ctx.json({ success: true });
  })
  .delete('/:workspaceId/:teamId', sessionMiddleware, async (ctx) => {
    const actor = ctx.get('user');
    const { workspaceId, teamId } = ctx.req.param();

    if (!await hasPermission({ workspaceId, userId: actor.$id, permissionCode: 'TEAM_MANAGE' })) {
      return ctx.json({ error: 'Forbidden: Missing TEAM_MANAGE permission.' }, 403);
    }

    await d1Run('DELETE FROM teams WHERE id = ? AND workspace_id = ?', [teamId, workspaceId]);

    logAudit({
      workspaceId,
      actorId: actor.$id,
      actorName: actor.name,
      action: 'DELETE_TEAM',
      entityType: 'TEAM',
      entityId: teamId,
      details: 'Team deleted',
    });

    return ctx.json({ success: true });
  });

export default app;
