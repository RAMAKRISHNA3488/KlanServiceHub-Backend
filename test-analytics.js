import { db } from './src/db.js';

async function testDrilldowns() {
  const ws = db.prepare('SELECT id, name FROM workspaces LIMIT 1').get();
  console.log('Testing Drilldown Entities on Workspace:', ws.name, `(${ws.id})`);

  // 1. Projects drilldown
  const projects = db.prepare(`
    SELECT p.id, p.name, p.key, p.category,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id) as total_tasks,
           (SELECT COUNT(*) FROM tasks WHERE project_id = p.id AND status IN ('DONE', 'Done')) as completed_tasks
    FROM projects p
    WHERE p.workspace_id = ? AND p.is_archived = 0
  `).all(ws.id);
  console.log('1. Projects:', projects);

  // 2. Active Projects drilldown
  const activeProjects = db.prepare(`
    SELECT p.id, p.name, p.key, COUNT(t.id) as active_tasks_count
    FROM projects p
    JOIN tasks t ON p.id = t.project_id AND t.status NOT IN ('DONE', 'Done', 'CANCELLED', 'Cancelled')
    WHERE p.workspace_id = ? AND p.is_archived = 0
    GROUP BY p.id
  `).all(ws.id);
  console.log('2. Active Projects:', activeProjects);

  // 3. Teams drilldown
  const teams = db.prepare(`
    SELECT t.id, t.name,
           (SELECT COUNT(*) FROM team_members WHERE team_id = t.id) as member_count,
           (SELECT COUNT(*) FROM tasks WHERE workspace_id = t.workspace_id) as total_tasks
    FROM teams t
    WHERE t.workspace_id = ?
  `).all(ws.id);
  console.log('3. Teams:', teams);

  // 4. Members drilldown
  const members = db.prepare(`
    SELECT m.id as member_id, m.role, u.name, u.email, u.job_title,
           (SELECT COUNT(*) FROM tasks WHERE workspace_id = m.workspace_id AND assignee_id = m.id) as total_assigned
    FROM members m
    JOIN users u ON m.user_id = u.id
    WHERE m.workspace_id = ?
  `).all(ws.id);
  console.log('4. Members:', members);

  console.log('\n🎉 ALL ENTITY DRILLDOWN QUERIES VALIDATED!');
}

testDrilldowns().catch(console.error);
