import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { d1All, d1First, d1Run, getD1Database, logActivity } from '../../../db.js';

// Supported Relationship Types and automatic inverse mappings
export const INVERSE_RELATIONSHIPS = {
  'blocks': 'is blocked by',
  'is blocked by': 'blocks',
  'relates to': 'relates to',
  'duplicates': 'is duplicated by',
  'is duplicated by': 'duplicates',
  'clones': 'is cloned by',
  'is cloned by': 'clones',
};

export const SUPPORTED_RELATIONSHIPS = Object.keys(INVERSE_RELATIONSHIPS);

export function normalizeRelationshipType(type) {
  if (!type) return 'relates to';
  const cleaned = type.toLowerCase().trim().replace(/[-_]/g, ' ');
  return INVERSE_RELATIONSHIPS[cleaned] ? cleaned : 'relates to';
}

export function getRelationshipCategory(relType) {
  const lower = (relType || '').toLowerCase().trim();
  if (lower === 'blocks') return 'blocks';
  if (lower === 'is blocked by') return 'isBlockedBy';
  if (lower === 'relates to') return 'relatesTo';
  if (lower === 'duplicates' || lower === 'is duplicated by') return 'duplicates';
  if (lower === 'clones' || lower === 'is cloned by') return 'clones';
  return 'relatesTo';
}

export function isStatusDone(status) {
  if (!status) return false;
  const s = String(status).trim().toUpperCase();
  return s === 'DONE' || s === 'RESOLVED' || s === 'CLOSED' || s === 'COMPLETED';
}

/**
 * Directed cycle detection for blocking relationships.
 * u -> v indicates "u blocks v" (v is blocked by u).
 * Checks if adding blockingTaskId -> blockedTaskId introduces a cycle.
 */
export async function hasDirectedBlockingCycle(d1, blockingTaskId, blockedTaskId, excludeLinkId = null) {
  if (blockingTaskId === blockedTaskId) return true;

  const allLinks = await d1All(`
    SELECT id, source_task_id, target_task_id, relationship_type 
    FROM task_links 
    WHERE relationship_type IN ('blocks', 'is blocked by')
  `, [], d1);

  const adj = new Map();
  for (const link of allLinks) {
    if (excludeLinkId && link.id === excludeLinkId) continue;
    let from = null;
    let to = null;
    const rel = (link.relationship_type || '').toLowerCase().trim();
    if (rel === 'blocks') {
      from = link.source_task_id;
      to = link.target_task_id;
    } else if (rel === 'is blocked by') {
      from = link.target_task_id;
      to = link.source_task_id;
    }
    if (from && to) {
      if (!adj.has(from)) adj.set(from, []);
      adj.get(from).push(to);
    }
  }

  // Check if blockedTaskId can reach blockingTaskId
  const visited = new Set();
  const queue = [blockedTaskId];
  visited.add(blockedTaskId);

  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === blockingTaskId) {
      return true;
    }
    const neighbors = adj.get(curr) || [];
    for (const nxt of neighbors) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }

  return false;
}

const ticketLinksApp = new Hono()
  // 1. POST /api/ticket-links - Create relationship
  .post('/', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const body = await ctx.req.json().catch(() => ({}));
    const sourceTaskId = body.sourceTicketId || body.sourceTaskId;
    const targetTaskId = body.targetTicketId || body.targetTaskId;
    const rawRel = body.relationshipType || body.relationship_type || 'relates to';
    const description = (body.description || '').trim();
    const d1 = ctx.env?.DB || getD1Database();

    if (!sourceTaskId || !targetTaskId) {
      return ctx.json({ error: 'Both sourceTicketId and targetTicketId are required.' }, 400);
    }

    if (sourceTaskId === targetTaskId) {
      return ctx.json({ error: 'A ticket cannot be linked to itself.' }, 400);
    }

    const relationshipType = normalizeRelationshipType(rawRel);

    // Fetch tickets to validate existence and same-project constraint
    const [sourceTask, targetTask] = await Promise.all([
      d1First('SELECT id, key, name, workspace_id, project_id, status FROM tasks WHERE id = ?', [sourceTaskId], d1),
      d1First('SELECT id, key, name, workspace_id, project_id, status FROM tasks WHERE id = ?', [targetTaskId], d1),
    ]);

    if (!sourceTask) {
      return ctx.json({ error: `Source ticket not found: ${sourceTaskId}` }, 404);
    }
    if (!targetTask) {
      return ctx.json({ error: `Target ticket not found: ${targetTaskId}` }, 404);
    }

    // Only allow tickets belonging to the same project to be linked
    if (sourceTask.project_id !== targetTask.project_id) {
      return ctx.json({ error: 'Only tickets belonging to the same project can be linked.' }, 400);
    }

    // Check duplicate relationships between the same pair of tickets
    const existing = await d1First(`
      SELECT id, relationship_type, source_task_id, target_task_id
      FROM task_links
      WHERE (source_task_id = ? AND target_task_id = ?)
         OR (source_task_id = ? AND target_task_id = ?)
    `, [sourceTaskId, targetTaskId, targetTaskId, sourceTaskId], d1);

    if (existing) {
      const existingRel = existing.relationship_type;
      const isSameDirection = existing.source_task_id === sourceTaskId;
      const effectiveExistingRel = isSameDirection ? existingRel : (INVERSE_RELATIONSHIPS[existingRel] || existingRel);
      if (effectiveExistingRel === relationshipType) {
        return ctx.json({ error: `These tickets are already linked with relationship: "${relationshipType}".` }, 400);
      }
    }

    // Circular dependency check for blocking relationships
    if (relationshipType === 'blocks' || relationshipType === 'is blocked by') {
      const blockerId = relationshipType === 'blocks' ? sourceTaskId : targetTaskId;
      const blockedId = relationshipType === 'blocks' ? targetTaskId : sourceTaskId;

      const hasCycle = await hasDirectedBlockingCycle(d1, blockerId, blockedId);
      if (hasCycle) {
        return ctx.json({
          error: `Circular dependency detected: Ticket ${targetTask.key || 'Target'} is already in the blocking chain of ${sourceTask.key || 'Source'}.`,
        }, 400);
      }
    }

    const id = randomUUID();
    const nowIso = new Date().toISOString();

    await d1Run(`
      INSERT INTO task_links (id, source_task_id, target_task_id, relationship_type, description, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [id, sourceTaskId, targetTaskId, relationshipType, description, user.$id, nowIso, nowIso], d1);

    // Activity History Logging for both tickets
    try {
      const inverseRel = INVERSE_RELATIONSHIPS[relationshipType] || relationshipType;
      await Promise.all([
        logActivity({
          workspaceId: sourceTask.workspace_id,
          projectId: sourceTask.project_id,
          taskId: sourceTaskId,
          userId: user.$id,
          action: `Linked ${sourceTask.key || 'ticket'} (${relationshipType}) to ${targetTask.key || 'ticket'}`,
          details: { linkId: id, relatedTicketId: targetTaskId, relationshipType, description },
        }, d1),
        logActivity({
          workspaceId: targetTask.workspace_id,
          projectId: targetTask.project_id,
          taskId: targetTaskId,
          userId: user.$id,
          action: `Linked ${targetTask.key || 'ticket'} (${inverseRel}) to ${sourceTask.key || 'ticket'}`,
          details: { linkId: id, relatedTicketId: sourceTaskId, relationshipType: inverseRel, description },
        }, d1),
      ]);
    } catch (e) {
      console.warn('Failed to log link activity:', e);
    }

    return ctx.json({
      success: true,
      data: {
        id,
        sourceTicketId: sourceTaskId,
        targetTicketId: targetTaskId,
        relationshipType,
        description,
        createdBy: user.$id,
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    }, 201);
  })

  // 2. GET /api/ticket-links/:linkId - Single link
  .get('/:linkId', sessionMiddleware, async (ctx) => {
    const { linkId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const link = await d1First(`
      SELECT l.*,
             st.key as source_key, st.name as source_title, st.status as source_status, st.priority as source_priority,
             tt.key as target_key, tt.name as target_title, tt.status as target_status, tt.priority as target_priority,
             u.name as creator_name
      FROM task_links l
      JOIN tasks st ON l.source_task_id = st.id
      JOIN tasks tt ON l.target_task_id = tt.id
      LEFT JOIN users u ON l.created_by = u.id
      WHERE l.id = ?
    `, [linkId], d1);

    if (!link) {
      return ctx.json({ error: 'Ticket link not found.' }, 404);
    }

    return ctx.json({
      data: {
        id: link.id,
        sourceTicketId: link.source_task_id,
        targetTicketId: link.target_task_id,
        relationshipType: link.relationship_type,
        description: link.description || '',
        createdBy: link.created_by,
        creatorName: link.creator_name,
        createdAt: link.created_at,
        updatedAt: link.updated_at,
        source: {
          id: link.source_task_id,
          key: link.source_key,
          title: link.source_title,
          status: link.source_status,
          priority: link.source_priority,
        },
        target: {
          id: link.target_task_id,
          key: link.target_key,
          title: link.target_title,
          status: link.target_status,
          priority: link.target_priority,
        },
      },
    });
  })

  // 3. PUT /api/ticket-links/:linkId - Update relationship or description
  .put('/:linkId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { linkId } = ctx.req.param();
    const body = await ctx.req.json().catch(() => ({}));
    const d1 = ctx.env?.DB || getD1Database();

    const existing = await d1First(`
      SELECT l.*, st.workspace_id, st.project_id, st.key as source_key, tt.key as target_key
      FROM task_links l
      JOIN tasks st ON l.source_task_id = st.id
      JOIN tasks tt ON l.target_task_id = tt.id
      WHERE l.id = ?
    `, [linkId], d1);

    if (!existing) {
      return ctx.json({ error: 'Ticket link not found.' }, 404);
    }

    const newRel = body.relationshipType ? normalizeRelationshipType(body.relationshipType) : existing.relationship_type;
    const newDesc = body.description !== undefined ? String(body.description).trim() : existing.description;
    const nowIso = new Date().toISOString();

    // Check cycle if changing to blocking relationship
    if ((newRel === 'blocks' || newRel === 'is blocked by') && newRel !== existing.relationship_type) {
      const blockerId = newRel === 'blocks' ? existing.source_task_id : existing.target_task_id;
      const blockedId = newRel === 'blocks' ? existing.target_task_id : existing.source_task_id;
      const hasCycle = await hasDirectedBlockingCycle(d1, blockerId, blockedId, linkId);
      if (hasCycle) {
        return ctx.json({
          error: `Circular dependency detected: Updating to ${newRel} would create a circular blocking chain.`,
        }, 400);
      }
    }

    await d1Run(`
      UPDATE task_links
      SET relationship_type = ?, description = ?, updated_at = ?
      WHERE id = ?
    `, [newRel, newDesc, nowIso, linkId], d1);

    try {
      logActivity({
        workspaceId: existing.workspace_id,
        projectId: existing.project_id,
        taskId: existing.source_task_id,
        userId: user.$id,
        action: `Updated relationship with ${existing.target_key || 'ticket'} to "${newRel}"`,
        details: { linkId, oldRelationship: existing.relationship_type, newRelationship: newRel },
      }, d1);
    } catch (e) {}

    return ctx.json({
      success: true,
      data: {
        id: linkId,
        sourceTicketId: existing.source_task_id,
        targetTicketId: existing.target_task_id,
        relationshipType: newRel,
        description: newDesc,
        updatedAt: nowIso,
      },
    });
  })

  // 4. DELETE /api/ticket-links/:linkId - Remove link
  .delete('/:linkId', sessionMiddleware, async (ctx) => {
    const user = ctx.get('user');
    const { linkId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();

    const link = await d1First(`
      SELECT l.*, st.workspace_id, st.project_id, st.key as source_key, tt.key as target_key
      FROM task_links l
      JOIN tasks st ON l.source_task_id = st.id
      JOIN tasks tt ON l.target_task_id = tt.id
      WHERE l.id = ?
    `, [linkId], d1);

    if (!link) {
      return ctx.json({ error: 'Ticket link not found.' }, 404);
    }

    await d1Run('DELETE FROM task_links WHERE id = ?', [linkId], d1);

    try {
      await Promise.all([
        logActivity({
          workspaceId: link.workspace_id,
          projectId: link.project_id,
          taskId: link.source_task_id,
          userId: user.$id,
          action: `Removed link (${link.relationship_type}) with ${link.target_key || 'ticket'}`,
          details: { linkId, targetTaskId: link.target_task_id },
        }, d1),
        logActivity({
          workspaceId: link.workspace_id,
          projectId: link.project_id,
          taskId: link.target_task_id,
          userId: user.$id,
          action: `Removed link with ${link.source_key || 'ticket'}`,
          details: { linkId, sourceTaskId: link.source_task_id },
        }, d1),
      ]);
    } catch (e) {}

    return ctx.json({ success: true, message: 'Relationship removed successfully.' });
  });

/**
 * Shared function to retrieve full links for a ticket with automatic inverse mappings & grouping
 */
export async function getTicketLinksData(ticketId, d1) {
  const currentTask = await d1First('SELECT id, key, name, project_id, status FROM tasks WHERE id = ?', [ticketId], d1);
  if (!currentTask) return null;

  const rawLinks = await d1All(`
    SELECT l.id as link_id, l.source_task_id, l.target_task_id, l.relationship_type, l.description,
           l.created_at, l.updated_at, l.created_by,
           st.id as s_id, st.key as s_key, COALESCE(st.name, '') as s_name, st.status as s_status, st.priority as s_priority,
           st.issue_type as s_issue_type, st.due_date as s_due_date, st.story_points as s_story_points,
           st.project_id as s_project_id, sp.name as s_project_name,
           su.name as s_assignee_name, su.avatar_url as s_assignee_avatar,
           tt.id as t_id, tt.key as t_key, COALESCE(tt.name, '') as t_name, tt.status as t_status, tt.priority as t_priority,
           tt.issue_type as t_issue_type, tt.due_date as t_due_date, tt.story_points as t_story_points,
           tt.project_id as t_project_id, tp.name as t_project_name,
           tu.name as t_assignee_name, tu.avatar_url as t_assignee_avatar,
           cu.name as creator_name
    FROM task_links l
    JOIN tasks st ON l.source_task_id = st.id
    JOIN tasks tt ON l.target_task_id = tt.id
    LEFT JOIN projects sp ON st.project_id = sp.id
    LEFT JOIN projects tp ON tt.project_id = tp.id
    LEFT JOIN members sm ON st.assignee_id = sm.id
    LEFT JOIN users su ON sm.user_id = su.id
    LEFT JOIN members tm ON tt.assignee_id = tm.id
    LEFT JOIN users tu ON tm.user_id = tu.id
    LEFT JOIN users cu ON l.created_by = cu.id
    WHERE l.source_task_id = ? OR l.target_task_id = ?
    ORDER BY l.created_at DESC
  `, [ticketId, ticketId], d1);

  const formattedLinks = [];
  const grouped = {
    blocks: [],
    isBlockedBy: [],
    relatesTo: [],
    duplicates: [],
    clones: [],
  };

  let unresolvedBlockersCount = 0;

  for (const row of rawLinks) {
    const isSource = row.source_task_id === ticketId;
    const rawRel = row.relationship_type || 'relates to';
    const effectiveRel = isSource ? rawRel : (INVERSE_RELATIONSHIPS[rawRel] || rawRel);

    const related = isSource
      ? {
          id: row.t_id,
          key: row.t_key,
          title: (row.t_name || '').trim() || 'Untitled Ticket',
          name: (row.t_name || '').trim() || 'Untitled Ticket',
          status: row.t_status,
          priority: row.t_priority,
          issueType: row.t_issue_type,
          dueDate: row.t_due_date,
          storyPoints: row.t_story_points,
          projectId: row.t_project_id,
          projectName: row.t_project_name,
          assignee: row.t_assignee_name ? { name: row.t_assignee_name, avatarUrl: row.t_assignee_avatar } : null,
        }
      : {
          id: row.s_id,
          key: row.s_key,
          title: (row.s_name || '').trim() || 'Untitled Ticket',
          name: (row.s_name || '').trim() || 'Untitled Ticket',
          status: row.s_status,
          priority: row.s_priority,
          issueType: row.s_issue_type,
          dueDate: row.s_due_date,
          storyPoints: row.s_story_points,
          projectId: row.s_project_id,
          projectName: row.s_project_name,
          assignee: row.s_assignee_name ? { name: row.s_assignee_name, avatarUrl: row.s_assignee_avatar } : null,
        };

    const isBlocker = effectiveRel === 'is blocked by' && !isStatusDone(related.status);
    if (isBlocker) {
      unresolvedBlockersCount++;
    }

    const item = {
      id: row.link_id,
      linkId: row.link_id,
      sourceTicketId: row.source_task_id,
      targetTicketId: row.target_task_id,
      relationshipType: effectiveRel,
      rawRelationshipType: rawRel,
      direction: isSource ? 'outgoing' : 'incoming',
      description: row.description || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      createdBy: row.created_by,
      creatorName: row.creator_name,
      ticket: related,
      isUnresolvedBlocker: isBlocker,
    };

    formattedLinks.push(item);

    const cat = getRelationshipCategory(effectiveRel);
    if (grouped[cat]) {
      grouped[cat].push(item);
    } else {
      grouped.relatesTo.push(item);
    }
  }

  return {
    ticketId,
    ticketKey: currentTask.key,
    ticketTitle: currentTask.name,
    totalLinks: formattedLinks.length,
    unresolvedBlockersCount,
    hasUnresolvedBlockers: unresolvedBlockersCount > 0,
    links: formattedLinks,
    grouped,
  };
}

/**
 * Shared function to compute dependency graph and linear visual chains for a ticket
 */
export async function getTicketDependenciesData(ticketId, d1) {
  const currentTask = await d1First(`
    SELECT t.id, t.key, t.name, t.status, t.priority, t.issue_type, t.project_id, p.name as project_name
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    WHERE t.id = ?
  `, [ticketId], d1);

  if (!currentTask) return null;

  // Fetch all blocking links within this project
  const projectLinks = await d1All(`
    SELECT l.id, l.source_task_id, l.target_task_id, l.relationship_type,
           st.key as source_key, st.name as source_name, st.status as source_status, st.priority as source_priority,
           tt.key as target_key, tt.name as target_name, tt.status as target_status, tt.priority as target_priority
    FROM task_links l
    JOIN tasks st ON l.source_task_id = st.id
    JOIN tasks tt ON l.target_task_id = tt.id
    WHERE st.project_id = ? AND l.relationship_type IN ('blocks', 'is blocked by')
  `, [currentTask.project_id], d1);

  // Normalize all edges: u -> v means u blocks v
  const blockersMap = new Map(); // v -> [u] (v is blocked by u)
  const blockedMap = new Map();  // u -> [v] (u blocks v)
  const taskMap = new Map();

  taskMap.set(currentTask.id, {
    id: currentTask.id,
    key: currentTask.key,
    name: currentTask.name,
    status: currentTask.status,
    priority: currentTask.priority,
    isCurrent: true,
  });

  for (const link of projectLinks) {
    let blockerId = null;
    let blockedId = null;
    let blockerData = null;
    let blockedData = null;

    if (link.relationship_type === 'blocks') {
      blockerId = link.source_task_id;
      blockedId = link.target_task_id;
      blockerData = { id: link.source_task_id, key: link.source_key, name: link.source_name, status: link.source_status, priority: link.source_priority };
      blockedData = { id: link.target_task_id, key: link.target_key, name: link.target_name, status: link.target_status, priority: link.target_priority };
    } else {
      blockerId = link.target_task_id;
      blockedId = link.source_task_id;
      blockerData = { id: link.target_task_id, key: link.target_key, name: link.target_name, status: link.target_status, priority: link.target_priority };
      blockedData = { id: link.source_task_id, key: link.source_key, name: link.source_name, status: link.source_status, priority: link.source_priority };
    }

    if (!taskMap.has(blockerId)) taskMap.set(blockerId, blockerData);
    if (!taskMap.has(blockedId)) taskMap.set(blockedId, blockedData);

    if (!blockedMap.has(blockerId)) blockedMap.set(blockerId, []);
    blockedMap.get(blockerId).push(blockedId);

    if (!blockersMap.has(blockedId)) blockersMap.set(blockedId, []);
    blockersMap.get(blockedId).push(blockerId);
  }

  // Find incoming chains (Tickets that block this ticket: A -> B -> currentTask)
  const incomingChains = [];
  function traceIncoming(currId, currentPath = [], depth = 0) {
    if (depth > 6) return;
    const directBlockers = blockersMap.get(currId) || [];
    if (directBlockers.length === 0 && currentPath.length > 0) {
      incomingChains.push([...currentPath]);
      return;
    }
    for (const bId of directBlockers) {
      if (!currentPath.some((node) => node.id === bId)) {
        const node = taskMap.get(bId);
        traceIncoming(bId, [node, ...currentPath], depth + 1);
      }
    }
  }

  const directBlockerIds = blockersMap.get(ticketId) || [];
  for (const bId of directBlockerIds) {
    const bNode = taskMap.get(bId);
    traceIncoming(bId, [bNode, taskMap.get(ticketId)], 0);
  }

  // Find outgoing chains (Tickets blocked by this ticket: currentTask -> X -> Y)
  const outgoingChains = [];
  function traceOutgoing(currId, currentPath = [], depth = 0) {
    if (depth > 6) return;
    const directBlocked = blockedMap.get(currId) || [];
    if (directBlocked.length === 0 && currentPath.length > 0) {
      outgoingChains.push([...currentPath]);
      return;
    }
    for (const dId of directBlocked) {
      if (!currentPath.some((node) => node.id === dId)) {
        const node = taskMap.get(dId);
        traceOutgoing(dId, [...currentPath, node], depth + 1);
      }
    }
  }

  const directBlockedIds = blockedMap.get(ticketId) || [];
  for (const dId of directBlockedIds) {
    const dNode = taskMap.get(dId);
    traceOutgoing(dId, [taskMap.get(ticketId), dNode], 0);
  }

  // Linear visual chains aggregation
  const visualChains = [];
  for (const chain of incomingChains) {
    visualChains.push({
      type: 'incoming',
      description: `Blocked by chain of ${chain.length - 1} ticket(s)`,
      nodes: chain,
      hasUnresolved: chain.some((n) => n.id !== ticketId && !isStatusDone(n.status)),
    });
  }
  for (const chain of outgoingChains) {
    visualChains.push({
      type: 'outgoing',
      description: `Blocks chain of ${chain.length - 1} ticket(s)`,
      nodes: chain,
      hasUnresolved: !isStatusDone(currentTask.status),
    });
  }

  const unresolvedDirectBlockers = directBlockerIds
    .map((id) => taskMap.get(id))
    .filter((n) => n && !isStatusDone(n.status));

  return {
    ticketId,
    ticket: currentTask,
    directBlockers: directBlockerIds.map((id) => taskMap.get(id)).filter(Boolean),
    directBlocked: directBlockedIds.map((id) => taskMap.get(id)).filter(Boolean),
    unresolvedDirectBlockers,
    hasBlockers: unresolvedDirectBlockers.length > 0,
    visualChains,
  };
}

// Sub-app for /api/tickets/:ticketId/...
export const ticketSubApp = new Hono()
  .get('/:ticketId/links', sessionMiddleware, async (ctx) => {
    const { ticketId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const data = await getTicketLinksData(ticketId, d1);
    if (!data) return ctx.json({ error: 'Ticket not found.' }, 404);
    return ctx.json({ data });
  })
  .get('/:ticketId/dependencies', sessionMiddleware, async (ctx) => {
    const { ticketId } = ctx.req.param();
    const d1 = ctx.env?.DB || getD1Database();
    const data = await getTicketDependenciesData(ticketId, d1);
    if (!data) return ctx.json({ error: 'Ticket not found.' }, 404);
    return ctx.json({ data });
  });

export default ticketLinksApp;
