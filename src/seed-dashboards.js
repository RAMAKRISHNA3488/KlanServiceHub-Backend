import { db } from './db.js';
import { randomUUID } from 'node:crypto';

const DEFAULT_TEMPLATES = [
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

export function seedAllWorkspaces() {
  const workspaces = db.prepare('SELECT id, user_id FROM workspaces').all();
  for (const ws of workspaces) {
    const existingCount = db.prepare('SELECT COUNT(*) as c FROM dashboards WHERE workspace_id = ?').get(ws.id).c;
    if (existingCount === 0) {
      for (const tpl of DEFAULT_TEMPLATES) {
        const dashId = randomUUID();
        db.prepare(`
          INSERT INTO dashboards (id, workspace_id, name, description, layout, is_default, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(dashId, ws.id, tpl.name, tpl.description, tpl.layout, tpl.is_default, ws.user_id);

        for (const g of tpl.gadgets) {
          db.prepare(`
            INSERT INTO dashboard_gadgets (id, dashboard_id, workspace_id, gadget_type, title, column_index, position, settings)
            VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
          `).run(randomUUID(), dashId, ws.id, g.gadget_type, g.title, g.column_index, g.position);
        }
      }
    }
  }
}

seedAllWorkspaces();
console.log('Seeded all workspaces successfully with dashboards and gadgets');
