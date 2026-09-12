import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

// Default gadgets template for newly initialized dashboards
const DEFAULT_DASHBOARD_TEMPLATES = [
  {
    name: 'Executive Overview',
    description: 'High-level operational KPIs, project delivery progress, and priority distribution.',
    layout: '2_COLUMN_EQUAL',
    is_default: 1,
    gadgets: [
      { gadget_type: 'PROJECT_PROGRESS', title: 'Project Delivery Progress', column_index: 0, position: 0 },
      { gadget_type: 'PRIORITY_BREAKDOWN', title: 'Priority Distribution', column_index: 1, position: 0 },
      { gadget_type: 'CREATED_VS_RESOLVED', title: 'Created vs Resolved Trend', column_index: 0, position: 1 },
      { gadget_type: 'TYPE_BREAKDOWN', title: 'Issue Types Distribution', column_index: 1, position: 1 },
      { gadget_type: 'TEAM_WORKLOAD', title: 'Team Workload & Capacity', column_index: 0, position: 2 },
      { gadget_type: 'ACTIVITY_STREAM', title: 'Recent Activity Stream', column_index: 1, position: 2 },
    ],
  },
  {
    name: 'Sprint Delivery & Agile Health',
    description: 'Active sprint execution, burndown velocity, and team member workload.',
    layout: '2_COLUMN_EQUAL',
    is_default: 0,
    gadgets: [
      { gadget_type: 'ACTIVE_SPRINTS', title: 'Active Sprints Health', column_index: 0, position: 0 },
      { gadget_type: 'ASSIGNED_TO_ME', title: 'My Work Queue', column_index: 1, position: 0 },
      { gadget_type: 'TEAM_WORKLOAD', title: 'Sprint Workload by Assignee', column_index: 0, position: 1 },
      { gadget_type: 'TWO_DIMENSIONAL', title: 'Assignee vs Status Matrix', column_index: 1, position: 1 },
    ],
  },
  {
    name: 'Quality & Incident Watch',
    description: 'Critical blocking issues, overdue tasks, and incident SLA tracking.',
    layout: '2_COLUMN_EQUAL',
    is_default: 0,
    gadgets: [
      { gadget_type: 'OVERDUE_WATCHLIST', title: 'Overdue Work Items Watchlist', column_index: 0, position: 0 },
      { gadget_type: 'PRIORITY_BREAKDOWN', title: 'Urgent & Critical Escalations', column_index: 1, position: 0 },
      { gadget_type: 'PROJECT_PROGRESS', title: 'Project Health Breakdown', column_index: 0, position: 1 },
      { gadget_type: 'ACTIVITY_STREAM', title: 'Incident & Issue Audit Trail', column_index: 1, position: 1 },
    ],
  },
];

function ensureDefaultDashboards(workspaceId, userId) {
  const existing = db.prepare('SELECT COUNT(*) as c FROM dashboards WHERE workspace_id = ?').get(workspaceId).c;
  if (existing > 0) return;

  for (const tpl of DEFAULT_DASHBOARD_TEMPLATES) {
    const dashId = randomUUID();
    db.prepare(`
      INSERT INTO dashboards (id, workspace_id, name, description, layout, is_default, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(dashId, workspaceId, tpl.name, tpl.description, tpl.layout, tpl.is_default, userId);

    for (const g of tpl.gadgets) {
      db.prepare(`
        INSERT INTO dashboard_gadgets (id, dashboard_id, workspace_id, gadget_type, title, column_index, position, settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
      `).run(randomUUID(), dashId, workspaceId, g.gadget_type, g.title, g.column_index, g.position);
    }
  }
}

const app = new Hono()
  // 1. Get dashboard data & gadgets
  .get('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const user = ctx.get('user');
    const requestedDashboardId = ctx.req.query('dashboardId');
    const projectIdFilter = ctx.req.query('projectId');

    ensureDefaultDashboards(workspaceId, user.$id);

    // List all dashboards in this workspace
    const dashboardsList = db.prepare(`
      SELECT * FROM dashboards 
      WHERE workspace_id = ? 
      ORDER BY is_default DESC, is_favorite DESC, created_at ASC
    `).all(workspaceId).map(formatDoc);

    // Find active dashboard
    let activeDashboard = null;
    if (requestedDashboardId) {
      activeDashboard = dashboardsList.find((d) => d.$id === requestedDashboardId || d.id === requestedDashboardId);
    }
    if (!activeDashboard) {
      activeDashboard = dashboardsList.find((d) => d.is_default) || dashboardsList[0];
    }

    // Fetch configured gadgets for this dashboard
    let configuredGadgets = [];
    if (activeDashboard) {
      const gRows = db.prepare(`
        SELECT * FROM dashboard_gadgets 
        WHERE dashboard_id = ? 
        ORDER BY column_index ASC, position ASC, created_at ASC
      `).all(activeDashboard.id || activeDashboard.$id);

      configuredGadgets = gRows.map((g) => ({
        ...formatDoc(g),
        settings: JSON.parse(g.settings || '{}'),
      }));
    }

    // Base query filter
    let whereSql = 'workspace_id = ?';
    const params = [workspaceId];
    if (projectIdFilter && projectIdFilter !== 'ALL') {
      whereSql += ' AND project_id = ?';
      params.push(projectIdFilter);
    }

    // 1. Summary Metrics
    const totalTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql}`).get(...params).c;
    const completedTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql} AND status = 'DONE'`).get(...params).c;
    const inProgressTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql} AND status IN ('IN_PROGRESS', 'IN_REVIEW', 'TESTING')`).get(...params).c;
    const todoTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql} AND status IN ('TODO', 'BACKLOG')`).get(...params).c;
    const criticalTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql} AND priority = 'CRITICAL' AND status != 'DONE'`).get(...params).c;
    const overdueTasks = db.prepare(`SELECT COUNT(*) as c FROM tasks WHERE ${whereSql} AND status != 'DONE' AND datetime(due_date) < datetime('now')`).get(...params).c;

    // 2. Priority Breakdown
    const pRows = db.prepare(`
      SELECT priority, COUNT(*) as count 
      FROM tasks 
      WHERE ${whereSql} 
      GROUP BY priority
    `).all(...params);

    const priorityOrder = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST'];
    const pMap = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, LOWEST: 0 };
    for (const r of pRows) {
      const pKey = (r.priority || 'MEDIUM').toUpperCase();
      if (pMap[pKey] !== undefined) {
        pMap[pKey] += Number(r.count);
      } else if (pKey === 'HIGHEST' || pKey === 'P0') {
        pMap.CRITICAL += Number(r.count);
      } else {
        pMap.MEDIUM += Number(r.count);
      }
    }
    const priorityBreakdown = priorityOrder.map((key) => ({
      priority: key,
      count: pMap[key],
      percentage: totalTasks > 0 ? Math.round((pMap[key] / totalTasks) * 100) : 0,
    }));

    // 3. Issue Type Breakdown
    const tRows = db.prepare(`
      SELECT issue_type, COUNT(*) as count 
      FROM tasks 
      WHERE ${whereSql} 
      GROUP BY issue_type
    `).all(...params);

    const typeBreakdown = tRows.map((r) => ({
      issue_type: r.issue_type || 'Task',
      count: Number(r.count),
      percentage: totalTasks > 0 ? Math.round((Number(r.count) / totalTasks) * 100) : 0,
    }));

    // 4. Team Workload
    const teamWorkload = db.prepare(`
      SELECT u.id, u.name, u.email, u.avatar_url, m.role,
             COUNT(t.id) as task_count,
             SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done_count,
             SUM(CASE WHEN t.status IN ('IN_PROGRESS', 'IN_REVIEW', 'TESTING') THEN 1 ELSE 0 END) as in_progress_count,
             SUM(CASE WHEN t.status != 'DONE' AND datetime(t.due_date) < datetime('now') THEN 1 ELSE 0 END) as overdue_count,
             SUM(CASE WHEN t.story_points IS NOT NULL THEN t.story_points ELSE 1 END) as total_story_points
      FROM members m
      JOIN users u ON m.user_id = u.id
      LEFT JOIN tasks t ON t.assignee_id = m.id ${projectIdFilter && projectIdFilter !== 'ALL' ? 'AND t.project_id = ?' : ''}
      WHERE m.workspace_id = ?
      GROUP BY u.id
      ORDER BY task_count DESC
      LIMIT 8
    `).all(...(projectIdFilter && projectIdFilter !== 'ALL' ? [projectIdFilter, workspaceId] : [workspaceId]));

    // 5. Project Progress
    const projectProgress = db.prepare(`
      SELECT p.id, p.name, p.key, p.image_url, p.category,
             COUNT(t.id) as total_tasks,
             SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as completed_tasks,
             SUM(CASE WHEN t.status IN ('IN_PROGRESS', 'IN_REVIEW', 'TESTING') THEN 1 ELSE 0 END) as in_progress_tasks,
             SUM(CASE WHEN t.status != 'DONE' AND t.issue_type = 'Bug' THEN 1 ELSE 0 END) as open_bugs
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      WHERE p.workspace_id = ?
      GROUP BY p.id
      ORDER BY total_tasks DESC
      LIMIT 8
    `).all(workspaceId).map((p) => ({
      ...p,
      progressPercent: p.total_tasks > 0 ? Math.round((p.completed_tasks / p.total_tasks) * 100) : 0,
    }));

    // 6. Active Sprints Summary
    const activeSprints = db.prepare(`
      SELECT s.*, p.name as project_name, p.key as project_key,
             COUNT(t.id) as total_tasks,
             SUM(CASE WHEN t.status = 'DONE' THEN 1 ELSE 0 END) as done_tasks,
             SUM(CASE WHEN t.status != 'DONE' THEN (CASE WHEN t.story_points IS NOT NULL THEN t.story_points ELSE 1 END) ELSE 0 END) as remaining_points
      FROM sprints s
      LEFT JOIN projects p ON s.project_id = p.id
      LEFT JOIN tasks t ON t.sprint_id = s.id
      WHERE s.workspace_id = ? AND s.status = 'ACTIVE'
      GROUP BY s.id
      ORDER BY s.start_date DESC
    `).all(workspaceId);

    // 7. Assigned to Me (current user quick items)
    const assignedToMe = db.prepare(`
      SELECT t.id, t.key, t.name, t.status, t.priority, t.due_date, t.issue_type,
             p.name as project_name, p.key as project_key
      FROM tasks t
      JOIN members m ON t.assignee_id = m.id
      JOIN projects p ON t.project_id = p.id
      WHERE t.workspace_id = ? AND m.user_id = ? AND t.status != 'DONE'
      ORDER BY (CASE WHEN t.priority = 'CRITICAL' THEN 1 WHEN t.priority = 'HIGH' THEN 2 ELSE 3 END), t.due_date ASC
      LIMIT 6
    `).all(workspaceId, user.$id);

    // 8. Overdue Watchlist
    const overdueWatchlist = db.prepare(`
      SELECT t.id, t.key, t.name, t.status, t.priority, t.due_date, t.issue_type,
             p.name as project_name, p.key as project_key,
             u.name as assignee_name, u.avatar_url as assignee_avatar
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE t.workspace_id = ? AND t.status != 'DONE' AND datetime(t.due_date) < datetime('now')
      ORDER BY (CASE WHEN t.priority = 'CRITICAL' THEN 1 WHEN t.priority = 'HIGH' THEN 2 ELSE 3 END), t.due_date ASC
      LIMIT 6
    `).all(workspaceId);

    // 9. Created vs Resolved Trend (Recent 6 months simulated/actual aggregate)
    const trendMonths = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const monthLabel = d.toLocaleString('en-US', { month: 'short' });
      const yearMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

      const createdCount = db.prepare(`
        SELECT COUNT(*) as c FROM tasks 
        WHERE ${whereSql} AND strftime('%Y-%m', created_at) = ?
      `).get(...params, yearMonth).c;

      const resolvedCount = db.prepare(`
        SELECT COUNT(*) as c FROM tasks 
        WHERE ${whereSql} AND status = 'DONE' AND strftime('%Y-%m', updated_at) = ?
      `).get(...params, yearMonth).c;

      trendMonths.push({
        month: monthLabel,
        created: createdCount,
        resolved: resolvedCount,
      });
    }

    // 10. Recent Activity Stream
    let recentActivities = [];
    try {
      recentActivities = db.prepare(`
        SELECT a.*, a.action as action_type, u.name as user_name, u.avatar_url as user_avatar, t.key as task_key, t.name as task_name
        FROM activities a
        LEFT JOIN users u ON a.user_id = u.id
        LEFT JOIN tasks t ON a.task_id = t.id
        WHERE a.workspace_id = ?
        ORDER BY a.created_at DESC
        LIMIT 8
      `).all(workspaceId);
    } catch (e) {
      console.error('Activities fetch error:', e);
    }

    // 11. Two-Dimensional Stats (Assignee vs Status Matrix)
    const matrixRows = db.prepare(`
      SELECT u.name as assignee_name, t.status, COUNT(t.id) as count
      FROM members m
      JOIN users u ON m.user_id = u.id
      JOIN tasks t ON t.assignee_id = m.id
      WHERE t.workspace_id = ?
      GROUP BY u.name, t.status
    `).all(workspaceId);

    const assigneesSet = new Set();
    const statusMatrix = {};
    for (const row of matrixRows) {
      assigneesSet.add(row.assignee_name);
      if (!statusMatrix[row.assignee_name]) {
        statusMatrix[row.assignee_name] = { TODO: 0, IN_PROGRESS: 0, IN_REVIEW: 0, DONE: 0, total: 0 };
      }
      statusMatrix[row.assignee_name][row.status] = (statusMatrix[row.assignee_name][row.status] || 0) + Number(row.count);
      statusMatrix[row.assignee_name].total += Number(row.count);
    }
    const twoDimensionalStats = Array.from(assigneesSet).map((name) => ({
      name,
      ...statusMatrix[name],
    }));

    return ctx.json({
      data: {
        dashboards: dashboardsList,
        activeDashboard: activeDashboard ? formatDoc(activeDashboard) : null,
        configuredGadgets,
        summary: {
          totalTasks,
          completedTasks,
          inProgressTasks,
          todoTasks,
          criticalTasks,
          overdueTasks,
          completionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
        },
        priorityBreakdown,
        typeBreakdown,
        teamWorkload,
        projectProgress,
        activeSprints,
        assignedToMe,
        overdueWatchlist,
        createdVsResolvedTrend: trendMonths,
        recentActivities,
        twoDimensionalStats,
      },
    });
  })

  // 2. Create new custom dashboard
  .post('/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const user = ctx.get('user');
    const { name, description = '', layout = '2_COLUMN_EQUAL', shareScope = 'PUBLIC' } = await ctx.req.json();

    if (!name || !name.trim()) {
      return ctx.json({ error: 'Dashboard name is required' }, 400);
    }

    const dashboardId = randomUUID();
    db.prepare(`
      INSERT INTO dashboards (id, workspace_id, name, description, layout, is_default, share_scope, created_by)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(dashboardId, workspaceId, name.trim(), description.trim(), layout, shareScope, user.$id);

    // Add default starter gadgets
    const starterGadgets = [
      { gadget_type: 'PROJECT_PROGRESS', title: 'Project Delivery Progress', column_index: 0, position: 0 },
      { gadget_type: 'PRIORITY_BREAKDOWN', title: 'Priority Distribution', column_index: 1, position: 0 },
      { gadget_type: 'TEAM_WORKLOAD', title: 'Team Workload & Capacity', column_index: 0, position: 1 },
      { gadget_type: 'ASSIGNED_TO_ME', title: 'My Work Items Queue', column_index: 1, position: 1 },
    ];

    for (const g of starterGadgets) {
      db.prepare(`
        INSERT INTO dashboard_gadgets (id, dashboard_id, workspace_id, gadget_type, title, column_index, position, settings)
        VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
      `).run(randomUUID(), dashboardId, workspaceId, g.gadget_type, g.title, g.column_index, g.position);
    }

    const created = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(dashboardId);
    return ctx.json({ data: formatDoc(created) });
  })

  // 3. Update dashboard
  .patch('/:workspaceId/:dashboardId', sessionMiddleware, async (ctx) => {
    const { workspaceId, dashboardId } = ctx.req.param();
    const { name, description, layout, isFavorite, isDefault, shareScope } = await ctx.req.json();

    const existing = db.prepare('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?').get(dashboardId, workspaceId);
    if (!existing) return ctx.json({ error: 'Dashboard not found' }, 404);

    const updates = [];
    const params = [];

    if (name) { updates.push('name = ?'); params.push(name.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description.trim()); }
    if (layout) { updates.push('layout = ?'); params.push(layout); }
    if (isFavorite !== undefined) { updates.push('is_favorite = ?'); params.push(isFavorite ? 1 : 0); }
    if (shareScope) { updates.push('share_scope = ?'); params.push(shareScope); }
    if (isDefault) {
      db.prepare('UPDATE dashboards SET is_default = 0 WHERE workspace_id = ?').run(workspaceId);
      updates.push('is_default = 1');
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      db.prepare(`UPDATE dashboards SET ${updates.join(', ')} WHERE id = ?`).run(...params, dashboardId);
    }

    const updated = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(dashboardId);
    return ctx.json({ data: formatDoc(updated) });
  })

  // 4. Delete dashboard
  .delete('/:workspaceId/:dashboardId', sessionMiddleware, async (ctx) => {
    const { workspaceId, dashboardId } = ctx.req.param();
    const existing = db.prepare('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?').get(dashboardId, workspaceId);
    if (!existing) return ctx.json({ error: 'Dashboard not found' }, 404);

    if (existing.is_default) {
      return ctx.json({ error: 'Cannot delete default dashboard.' }, 400);
    }

    db.prepare('DELETE FROM dashboard_gadgets WHERE dashboard_id = ?').run(dashboardId);
    db.prepare('DELETE FROM dashboards WHERE id = ?').run(dashboardId);

    return ctx.json({ success: true, message: 'Dashboard deleted' });
  })

  // 5. Add gadget to dashboard
  .post('/:workspaceId/:dashboardId/gadgets', sessionMiddleware, async (ctx) => {
    const { workspaceId, dashboardId } = ctx.req.param();
    const user = ctx.get('user');
    const { gadgetType, title, columnIndex = 0, settings = {} } = await ctx.req.json();

    if (!gadgetType || !title) {
      return ctx.json({ error: 'gadgetType and title are required' }, 400);
    }

    ensureDefaultDashboards(workspaceId, user.$id);

    let targetDash = db.prepare('SELECT * FROM dashboards WHERE id = ? AND workspace_id = ?').get(dashboardId, workspaceId);
    if (!targetDash) {
      targetDash = db.prepare('SELECT * FROM dashboards WHERE workspace_id = ? ORDER BY is_default DESC LIMIT 1').get(workspaceId);
    }
    const targetDashId = targetDash ? targetDash.id : dashboardId;
    const colIdx = Number(columnIndex) || 0;

    const maxPosRow = db.prepare(`
      SELECT MAX(position) as max_pos FROM dashboard_gadgets 
      WHERE dashboard_id = ? AND column_index = ?
    `).get(targetDashId, colIdx);

    const newPos = (maxPosRow?.max_pos !== null && maxPosRow?.max_pos !== undefined) ? Number(maxPosRow.max_pos) + 1 : 0;
    const gadgetId = randomUUID();

    db.prepare(`
      INSERT INTO dashboard_gadgets (id, dashboard_id, workspace_id, gadget_type, title, column_index, position, settings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(gadgetId, targetDashId, workspaceId, gadgetType, title, colIdx, newPos, JSON.stringify(settings));

    const gadget = db.prepare('SELECT * FROM dashboard_gadgets WHERE id = ?').get(gadgetId);
    return ctx.json({ data: { ...formatDoc(gadget), settings } });
  })

  // 6. Update / remove gadget
  .delete('/:workspaceId/:dashboardId/gadgets/:gadgetId', sessionMiddleware, async (ctx) => {
    const { gadgetId } = ctx.req.param();
    db.prepare('DELETE FROM dashboard_gadgets WHERE id = ?').run(gadgetId);
    return ctx.json({ success: true });
  });

export default app;

