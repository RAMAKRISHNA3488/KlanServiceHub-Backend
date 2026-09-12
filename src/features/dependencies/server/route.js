import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logActivity } from '../../../db.js';

const app = new Hono()
  // 1. GET FULL WORKSPACE DEPENDENCY TOPOLOGY GRAPH
  .get('/graph/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const query = ctx.req.query();
    const projectId = query.projectId;

    // Fetch rich tasks
    let taskSql = `
      SELECT t.id, t.key, t.name, t.status, t.priority, t.issue_type, t.due_date, t.story_points,
             t.project_id, p.name as project_name, p.key as project_key,
             u.name as assignee_name, u.avatar_url as assignee_avatar
      FROM tasks t
      JOIN projects p ON t.project_id = p.id
      LEFT JOIN members m ON t.assignee_id = m.id
      LEFT JOIN users u ON m.user_id = u.id
      WHERE t.workspace_id = ?
    `;
    const taskParams = [workspaceId];

    if (projectId && projectId !== 'ALL') {
      taskSql += ` AND t.project_id = ?`;
      taskParams.push(projectId);
    }

    const tasks = db.prepare(taskSql).all(...taskParams);

    // Fetch all dependency links
    const links = db.prepare(`
      SELECT l.id, l.source_task_id, l.target_task_id, l.relationship_type, l.created_at,
             st.key as source_key, st.name as source_name, st.status as source_status, st.priority as source_priority,
             st.project_id as source_project_id, sp.name as source_project_name, sp.key as source_project_key,
             tt.key as target_key, tt.name as target_name, tt.status as target_status, tt.priority as target_priority,
             tt.project_id as target_project_id, tp.name as target_project_name, tp.key as target_project_key,
             u.name as creator_name
      FROM task_links l
      JOIN tasks st ON l.source_task_id = st.id
      JOIN tasks tt ON l.target_task_id = tt.id
      JOIN projects sp ON st.project_id = sp.id
      JOIN projects tp ON tt.project_id = tp.id
      LEFT JOIN users u ON l.created_by = u.id
      WHERE st.workspace_id = ?
      ORDER BY l.created_at DESC
    `).all(workspaceId);

    const blockedNodes = new Set();
    const blockingNodes = new Set();
    let crossProjectCount = 0;
    const projectPairsMap = new Map();

    const formattedEdges = links.map((link) => {
      const isCrossProject = link.source_project_id !== link.target_project_id;
      if (isCrossProject) crossProjectCount++;

      const isBlocker =
        link.relationship_type === 'blocks' &&
        link.source_status !== 'DONE' &&
        link.source_status !== 'Done' &&
        link.source_status !== 'RESOLVED';

      if (isBlocker) {
        blockedNodes.add(link.target_task_id);
        blockingNodes.add(link.source_task_id);
      }

      const pairKey = `${link.source_project_key} -> ${link.target_project_key}`;
      projectPairsMap.set(pairKey, (projectPairsMap.get(pairKey) || 0) + 1);

      return {
        id: link.id,
        source: link.source_task_id,
        target: link.target_task_id,
        relationshipType: link.relationship_type,
        sourceKey: link.source_key,
        sourceName: link.source_name,
        sourceStatus: link.source_status,
        sourcePriority: link.source_priority,
        sourceProject: {
          id: link.source_project_id,
          name: link.source_project_name,
          key: link.source_project_key,
        },
        targetKey: link.target_key,
        targetName: link.target_name,
        targetStatus: link.target_status,
        targetPriority: link.target_priority,
        targetProject: {
          id: link.target_project_id,
          name: link.target_project_name,
          key: link.target_project_key,
        },
        isCrossProject,
        isActiveBlocker: isBlocker,
        creatorName: link.creator_name,
        createdAt: link.created_at,
      };
    });

    // Color assigner for projects
    const projectColors = [
      '#3B82F6', '#8B5CF6', '#EC4899', '#10B981', '#F59E0B', '#06B6D4', '#6366F1'
    ];
    const uniqueProjects = Array.from(new Set(tasks.map((t) => t.project_id)));
    const projectColorMap = {};
    uniqueProjects.forEach((pId, idx) => {
      projectColorMap[pId] = projectColors[idx % projectColors.length];
    });

    const formattedNodes = tasks.map((t) => ({
      id: t.id,
      key: t.key || 'TASK',
      name: t.name,
      status: t.status,
      priority: t.priority || 'MEDIUM',
      issueType: t.issue_type || 'Task',
      dueDate: t.due_date,
      storyPoints: t.story_points || 0,
      projectId: t.project_id,
      projectName: t.project_name,
      projectKey: t.project_key,
      projectColor: projectColorMap[t.project_id] || '#3B82F6',
      assignee: t.assignee_name
        ? { name: t.assignee_name, avatarUrl: t.assignee_avatar }
        : null,
      isBlocked: blockedNodes.has(t.id),
      isBlocking: blockingNodes.has(t.id),
      inDegree: formattedEdges.filter((e) => e.target === t.id).length,
      outDegree: formattedEdges.filter((e) => e.source === t.id).length,
    }));

    return ctx.json({
      data: {
        nodes: formattedNodes,
        edges: formattedEdges,
        blockedNodes: Array.from(blockedNodes),
        blockingNodes: Array.from(blockingNodes),
        totalDependencies: formattedEdges.length,
        crossProjectCount,
        criticalBlockersCount: blockedNodes.size,
        projectPairs: Array.from(projectPairsMap.entries()).map(([pair, count]) => ({
          pair,
          count,
        })),
      },
    });
  })

  // 2. GET PROJECT-SPECIFIC DEPENDENCY LINKS
  .get('/project/:projectId', sessionMiddleware, async (ctx) => {
    const { projectId } = ctx.req.param();

    const links = db.prepare(`
      SELECT l.*, st.key as source_key, st.name as source_name, st.status as source_status,
             tt.key as target_key, tt.name as target_name, tt.status as target_status,
             sp.name as source_project, tp.name as target_project
      FROM task_links l
      JOIN tasks st ON l.source_task_id = st.id
      JOIN tasks tt ON l.target_task_id = tt.id
      JOIN projects sp ON st.project_id = sp.id
      JOIN projects tp ON tt.project_id = tp.id
      WHERE st.project_id = ? OR tt.project_id = ?
      ORDER BY l.created_at DESC
    `).all(projectId, projectId);

    return ctx.json({ data: links.map(formatDoc) });
  })

  // 3. CREATE A NEW CROSS-PROJECT DEPENDENCY LINK
  .post('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { sourceTaskId, targetTaskId, relationshipType = 'blocks' } = await ctx.req.json();

    if (!sourceTaskId || !targetTaskId) {
      return ctx.json({ error: 'sourceTaskId and targetTaskId are required.' }, 400);
    }

    if (sourceTaskId === targetTaskId) {
      return ctx.json({ error: 'An issue cannot depend on itself.' }, 400);
    }

    // Check if tasks exist
    const sourceTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sourceTaskId);
    const targetTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(targetTaskId);

    if (!sourceTask || !targetTask) {
      return ctx.json({ error: 'Source or target task not found.' }, 404);
    }

    // Check duplicate link
    const existing = db.prepare(`
      SELECT id FROM task_links WHERE source_task_id = ? AND target_task_id = ?
    `).get(sourceTaskId, targetTaskId);

    if (existing) {
      return ctx.json({ error: 'This dependency relationship already exists.' }, 400);
    }

    // Circular dependency check
    const existingOpposite = db.prepare(`
      SELECT id FROM task_links WHERE source_task_id = ? AND target_task_id = ?
    `).get(targetTaskId, sourceTaskId);

    if (existingOpposite) {
      return ctx.json({ error: 'Circular dependency detected. Target issue already links back to source issue.' }, 400);
    }

    const id = randomUUID();
    db.prepare(`
      INSERT INTO task_links (id, source_task_id, target_task_id, relationship_type, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, sourceTaskId, targetTaskId, relationshipType, user.$id);

    try {
      logActivity({
        workspaceId: sourceTask.workspace_id,
        projectId: sourceTask.project_id,
        taskId: sourceTaskId,
        userId: user.$id,
        action: `Linked ${sourceTask.key || 'issue'} (${relationshipType}) to ${targetTask.key || 'issue'}`,
      });
    } catch (e) {}

    return ctx.json({
      success: true,
      data: {
        id,
        sourceTaskId,
        targetTaskId,
        relationshipType,
      },
    });
  })

  // 4. DELETE A DEPENDENCY LINK
  .delete('/:id', sessionMiddleware, async (ctx) => {
    const { id } = ctx.req.param();
    const link = db.prepare('SELECT * FROM task_links WHERE id = ?').get(id);

    if (!link) {
      return ctx.json({ error: 'Dependency link not found.' }, 404);
    }

    db.prepare('DELETE FROM task_links WHERE id = ?').run(id);

    return ctx.json({ success: true, message: 'Dependency link removed.' });
  })

  // 5. SEED DEMO SAMPLE DEPENDENCIES (IF NONE EXIST OR FOR EXPLORATION)
  .post('/seed-demo/:workspaceId', sessionMiddleware, async (ctx) => {
    const { workspaceId } = ctx.req.param();
    const user = ctx.get('user');

    const tasks = db.prepare(`
      SELECT id, project_id, status FROM tasks WHERE workspace_id = ? LIMIT 20
    `).all(workspaceId);

    if (tasks.length < 2) {
      return ctx.json({ error: 'Need at least 2 tasks in workspace to generate sample links.' }, 400);
    }

    let createdCount = 0;
    for (let i = 0; i < tasks.length - 1; i += 2) {
      const source = tasks[i];
      const target = tasks[i + 1];
      if (source.id !== target.id) {
        const existing = db.prepare(`
          SELECT id FROM task_links 
          WHERE (source_task_id = ? AND target_task_id = ?) OR (source_task_id = ? AND target_task_id = ?)
        `).get(source.id, target.id, target.id, source.id);

        if (!existing) {
          const id = randomUUID();
          const relType = i % 4 === 0 ? 'blocks' : i % 4 === 2 ? 'relates to' : 'blocks';
          db.prepare(`
            INSERT INTO task_links (id, source_task_id, target_task_id, relationship_type, created_by)
            VALUES (?, ?, ?, ?, ?)
          `).run(id, source.id, target.id, relType, user.$id);
          createdCount++;
        }
      }
    }

    return ctx.json({ success: true, createdCount, message: `Created ${createdCount} sample dependency link(s).` });
  });

export default app;
