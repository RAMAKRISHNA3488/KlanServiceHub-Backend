import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, d1All, d1First, d1Run, getD1Database, formatDoc } from '../../../db.js';

const app = new Hono()
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const capacities = await d1All(`
      SELECT c.*, u.name as user_name, u.email as user_email, u.avatar_url as user_avatar,
             t.name as team_name
      FROM team_capacities c
      JOIN users u ON c.user_id = u.id
      LEFT JOIN teams t ON c.team_id = t.id
      WHERE c.workspace_id = ?
    `, [workspaceId], d1);

    return ctx.json({ data: capacities.map(formatDoc) });
  })
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const { userId, teamId = null, workingHoursPerDay = 8.0, availabilityPercentage = 100.0 } = await ctx.req.json();
    const d1 = ctx.env?.DB || getD1Database();

    if (!userId) return ctx.json({ error: 'userId is required.' }, 400);

    const capacityHours = (workingHoursPerDay * 5) * (availabilityPercentage / 100);
    const id = randomUUID();

    await d1Run(`
      INSERT INTO team_capacities (id, workspace_id, team_id, user_id, working_hours_per_day, availability_percentage, capacity_hours)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, workspaceId, teamId || null, userId, workingHoursPerDay, availabilityPercentage, capacityHours], d1);

    return ctx.json({
      success: true,
      data: {
        id,
        userId,
        capacityHours,
        availabilityPercentage,
      },
    });
  })
  .get('/workload/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    // Query active members and their assigned story points & tasks
    const members = await d1All(`
      SELECT m.id as member_id, m.user_id, u.name, u.email, u.avatar_url
      FROM members m
      JOIN users u ON m.user_id = u.id
      WHERE m.workspace_id = ?
    `, [workspaceId], d1);

    const workloads = [];
    for (const m of members) {
      const taskStats = await d1First(`
        SELECT COUNT(*) as task_count,
               COALESCE(SUM(story_points), 0) as total_story_points,
               COALESCE(SUM(time_spent_seconds), 0) as total_spent_seconds
        FROM tasks
        WHERE assignee_id = ? AND workspace_id = ? AND status != 'DONE'
      `, [m.member_id, workspaceId], d1);

      const capacity = await d1First(`
        SELECT capacity_hours FROM team_capacities WHERE user_id = ? AND workspace_id = ?
      `, [m.user_id, workspaceId], d1);

      const capacityHours = capacity?.capacity_hours || 40.0;
      const estimatedHours = (taskStats?.total_story_points || 0) * 8.0;
      const utilization = Math.round((estimatedHours / capacityHours) * 100);

      workloads.push({
        userId: m.user_id,
        name: m.name,
        email: m.email,
        assignedTasksCount: taskStats?.task_count || 0,
        totalStoryPoints: taskStats?.total_story_points || 0,
        capacityHours,
        estimatedHours,
        utilizationPercentage: utilization,
        isOverloaded: utilization > 100,
      });
    }

    return ctx.json({ data: workloads });
  });

export default app;
