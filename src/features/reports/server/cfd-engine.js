import { d1All, d1First, getD1Database } from '../../../db.js';

// Standard Workflow Statuses in topological Kanban flow (from source to completion)
export const DEFAULT_WORKFLOW_STATUSES = [
  { key: 'DONE', label: 'Done', color: '#10B981', category: 'DONE', position: 7 },
  { key: 'TESTING', label: 'Testing', color: '#06B6D4', category: 'IN_PROGRESS', position: 6 },
  { key: 'CODE_REVIEW', label: 'Code Review', color: '#8B5CF6', category: 'IN_PROGRESS', position: 5 },
  { key: 'IN_PROGRESS', label: 'In Progress', color: '#3B82F6', category: 'IN_PROGRESS', position: 4 },
  { key: 'SELECTED_FOR_DEVELOPMENT', label: 'Selected for Dev', color: '#EC4899', category: 'TODO', position: 3 },
  { key: 'TODO', label: 'To Do', color: '#64748B', category: 'TODO', position: 2 },
  { key: 'BACKLOG', label: 'Backlog', color: '#94A3B8', category: 'TODO', position: 1 },
];

export const STATUS_CANONICAL_MAP = {
  'BACKLOG': 'BACKLOG',
  'Backlog': 'BACKLOG',
  'TODO': 'TODO',
  'To Do': 'TODO',
  'TO_DO': 'TODO',
  'SELECTED_FOR_DEVELOPMENT': 'SELECTED_FOR_DEVELOPMENT',
  'Selected for Development': 'SELECTED_FOR_DEVELOPMENT',
  'Selected for Dev': 'SELECTED_FOR_DEVELOPMENT',
  'IN_PROGRESS': 'IN_PROGRESS',
  'In Progress': 'IN_PROGRESS',
  'IN_REVIEW': 'CODE_REVIEW',
  'In Review': 'CODE_REVIEW',
  'CODE_REVIEW': 'CODE_REVIEW',
  'Code Review': 'CODE_REVIEW',
  'REVIEW': 'CODE_REVIEW',
  'Review': 'CODE_REVIEW',
  'TESTING': 'TESTING',
  'Testing': 'TESTING',
  'QA': 'TESTING',
  'DONE': 'DONE',
  'Done': 'DONE',
  'RESOLVED': 'DONE',
  'Resolved': 'DONE',
  'CLOSED': 'DONE',
  'Closed': 'DONE',
  'COMPLETED': 'DONE',
  'Completed': 'DONE',
};

export function normalizeStatus(rawStatus) {
  if (!rawStatus) return 'TODO';
  const trimmed = String(rawStatus).trim();
  return STATUS_CANONICAL_MAP[trimmed] || trimmed.toUpperCase().replace(/\s+/g, '_');
}

/**
 * Generate discrete date intervals for CFD timeline.
 */
export function generateTimelineBuckets(startDateStr, endDateStr, interval = 'daily') {
  const buckets = [];
  const start = new Date(startDateStr);
  const end = new Date(endDateStr);

  // Normalize hours
  start.setUTCHours(0, 0, 0, 0);
  end.setUTCHours(23, 59, 59, 999);

  const current = new Date(start);

  while (current <= end) {
    const bucketDate = new Date(current);
    const dateKey = bucketDate.toISOString().slice(0, 10);
    // End of that bucket period for cumulative evaluation
    const evalTimestamp = new Date(current);
    evalTimestamp.setUTCHours(23, 59, 59, 999);

    buckets.push({
      date: dateKey,
      timestamp: evalTimestamp.getTime(),
      isoString: evalTimestamp.toISOString(),
      label: bucketDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });

    if (interval === 'weekly') {
      current.setUTCDate(current.getUTCDate() + 7);
    } else if (interval === 'monthly') {
      current.setUTCMonth(current.getUTCMonth() + 1);
    } else {
      current.setUTCDate(current.getUTCDate() + 1);
    }
  }

  // Ensure last date is included if not already
  if (buckets.length === 0 || buckets[buckets.length - 1].date !== end.toISOString().slice(0, 10)) {
    const evalTimestamp = new Date(end);
    buckets.push({
      date: end.toISOString().slice(0, 10),
      timestamp: evalTimestamp.getTime(),
      isoString: evalTimestamp.toISOString(),
      label: evalTimestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    });
  }

  return buckets;
}

/**
 * Build task query filters matching the workspace and parameters.
 */
export function buildCFDFilter(query, workspaceId) {
  const whereClauses = ['t.workspace_id = ?'];
  const params = [workspaceId];

  if (query.projectId && query.projectId !== 'ALL') {
    whereClauses.push('t.project_id = ?');
    params.push(query.projectId);
  }

  if (query.teamId && query.teamId !== 'ALL') {
    whereClauses.push(`(
      t.assignee_id IN (
        SELECT m.id FROM members m 
        JOIN team_members tm ON m.user_id = tm.user_id 
        WHERE tm.team_id = ?
      )
      OR t.id IN (
        SELECT ta.task_id FROM task_assignees ta
        JOIN members m ON ta.member_id = m.id
        JOIN team_members tm ON m.user_id = tm.user_id
        WHERE tm.team_id = ?
      )
      OR t.project_id IN (
        SELECT project_id FROM team_projects WHERE team_id = ?
      )
    )`);
    params.push(query.teamId, query.teamId, query.teamId);
  }

  if (query.assigneeId && query.assigneeId !== 'ALL') {
    if (query.assigneeId === 'UNASSIGNED') {
      whereClauses.push('t.assignee_id IS NULL');
    } else {
      whereClauses.push('(t.assignee_id = ? OR t.id IN (SELECT task_id FROM task_assignees WHERE member_id = ?))');
      params.push(query.assigneeId, query.assigneeId);
    }
  }

  if (query.sprintId && query.sprintId !== 'ALL') {
    whereClauses.push('t.sprint_id = ?');
    params.push(query.sprintId);
  }

  if (query.epicId && query.epicId !== 'ALL') {
    whereClauses.push('t.epic_id = ?');
    params.push(query.epicId);
  }

  if (query.priority && query.priority !== 'ALL') {
    whereClauses.push('UPPER(t.priority) = UPPER(?)');
    params.push(query.priority);
  }

  if (query.issueType && query.issueType !== 'ALL') {
    whereClauses.push('LOWER(t.issue_type) = LOWER(?)');
    params.push(query.issueType);
  }

  return {
    whereSql: whereClauses.join(' AND '),
    params,
  };
}

/**
 * Retrieve timeline series and status breakdown for Cumulative Flow Diagram.
 */
export async function getCumulativeFlowData({ workspaceId, query, d1 }) {
  const dbInstance = d1 || getD1Database();

  // Date range determination
  const dateRange = query.dateRange || '30d';
  const now = new Date();
  let startDate = new Date();
  let endDate = new Date(now);

  if (dateRange === '7d') {
    startDate.setDate(now.getDate() - 7);
  } else if (dateRange === '14d') {
    startDate.setDate(now.getDate() - 14);
  } else if (dateRange === '90d') {
    startDate.setDate(now.getDate() - 90);
  } else if (dateRange === 'custom' && query.startDate && query.endDate) {
    startDate = new Date(query.startDate);
    endDate = new Date(query.endDate);
  } else {
    // Default 30 days
    startDate.setDate(now.getDate() - 30);
  }

  const interval = query.interval || 'daily';
  const buckets = generateTimelineBuckets(startDate.toISOString(), endDate.toISOString(), interval);

  const { whereSql, params } = buildCFDFilter(query, workspaceId);

  // Retrieve tasks matching filters
  const tasks = await d1All(`
    SELECT t.id, t.key, t.name, t.project_id, t.status, t.priority, t.created_at, t.completed_at
    FROM tasks t
    WHERE ${whereSql}
  `, params, dbInstance);

  if (!tasks || tasks.length === 0) {
    return {
      timeline: buckets.map((b) => ({
        date: b.date,
        label: b.label,
        total: 0,
        statuses: {},
        cumulative: {},
      })),
      statuses: DEFAULT_WORKFLOW_STATUSES,
      dateRange: {
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        interval,
      },
      totalTickets: 0,
    };
  }

  const taskIds = tasks.map((t) => t.id);
  const taskMap = new Map();
  tasks.forEach((t) => {
    taskMap.set(t.id, {
      ...t,
      createdAtMs: new Date(t.created_at).getTime(),
      completedAtMs: t.completed_at ? new Date(t.completed_at).getTime() : null,
      transitions: [],
    });
  });

  // Query transition history for matching tasks
  // Chunking taskIds to prevent SQL query limit overflow if many tasks exist
  const CHUNK_SIZE = 90;
  for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
    const chunk = taskIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const historyRows = await d1All(`
      SELECT ticket_id, previous_status, new_status, changed_at
      FROM ticket_status_history
      WHERE ticket_id IN (${placeholders})
      ORDER BY changed_at ASC
    `, chunk, dbInstance);

    for (const h of historyRows) {
      const task = taskMap.get(h.ticket_id);
      if (task) {
        task.transitions.push({
          previousStatus: normalizeStatus(h.previous_status),
          newStatus: normalizeStatus(h.new_status),
          changedAtMs: new Date(h.changed_at).getTime(),
          changedAtIso: h.changed_at,
        });
      }
    }
  }

  // Detect custom workflow statuses if configured for projects in scope
  const activeStatuses = [...DEFAULT_WORKFLOW_STATUSES];
  const presentStatusKeys = new Set(activeStatuses.map((s) => s.key));

  // Verify any additional statuses present in tasks or transitions
  taskMap.forEach((t) => {
    const cur = normalizeStatus(t.status);
    if (!presentStatusKeys.has(cur)) {
      presentStatusKeys.add(cur);
      activeStatuses.push({
        key: cur,
        label: cur.charAt(0) + cur.slice(1).toLowerCase().replace(/_/g, ' '),
        color: '#6366F1',
        category: 'IN_PROGRESS',
        position: 4,
      });
    }
  });

  // Sort statuses in order from Done up to Backlog
  const sortedStatuses = activeStatuses.sort((a, b) => b.position - a.position);

  // Reconstruct historical status distribution for each date bucket
  const timeline = buckets.map((bucket) => {
    const bucketTime = bucket.timestamp;
    const statusCounts = {};
    sortedStatuses.forEach((s) => {
      statusCounts[s.key] = 0;
    });

    let activeTotal = 0;

    taskMap.forEach((task) => {
      // If task was created after this bucket timestamp, it didn't exist yet
      if (task.createdAtMs > bucketTime) return;

      // Find status at bucketTime from transitions
      let statusAtBucket = null;

      // Find the last transition on or before bucketTime
      for (let i = task.transitions.length - 1; i >= 0; i--) {
        const trans = task.transitions[i];
        if (trans.changedAtMs <= bucketTime) {
          statusAtBucket = trans.newStatus;
          break;
        }
      }

      // If no transition before bucketTime, fall back to initial task state
      if (!statusAtBucket) {
        if (task.transitions.length > 0) {
          statusAtBucket = task.transitions[0].previousStatus || task.transitions[0].newStatus;
        } else {
          statusAtBucket = normalizeStatus(task.status);
        }
      }

      statusAtBucket = normalizeStatus(statusAtBucket);

      if (statusCounts[statusAtBucket] !== undefined) {
        statusCounts[statusAtBucket]++;
      } else {
        statusCounts[statusAtBucket] = 1;
      }
      activeTotal++;
    });

    // Calculate cumulative stack values (from Done upwards)
    const cumulative = {};
    let runningCumulative = 0;
    sortedStatuses.forEach((st) => {
      const count = statusCounts[st.key] || 0;
      runningCumulative += count;
      cumulative[st.key] = runningCumulative;
    });

    return {
      date: bucket.date,
      label: bucket.label,
      total: activeTotal,
      statuses: statusCounts,
      cumulative,
    };
  });

  return {
    timeline,
    statuses: sortedStatuses,
    dateRange: {
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
      interval,
    },
    totalTickets: tasks.length,
  };
}

/**
 * Calculate the 7 Analytics Summary KPIs for Cumulative Flow.
 */
export async function getCFDSummaryMetrics({ workspaceId, query, d1 }) {
  const dbInstance = d1 || getD1Database();
  const cfdData = await getCumulativeFlowData({ workspaceId, query, d1 });
  const { whereSql, params } = buildCFDFilter(query, workspaceId);

  // Retrieve matching tasks with transition history for lead/cycle time
  const tasks = await d1All(`
    SELECT t.id, t.key, t.name, t.status, t.created_at, t.completed_at
    FROM tasks t
    WHERE ${whereSql}
  `, params, dbInstance);

  const totalTickets = tasks.length;
  let completedTickets = 0;
  let wipTickets = 0;

  const cycleTimesDays = [];
  const leadTimesDays = [];

  const taskIds = tasks.map((t) => t.id);
  const transitionsByTaskId = new Map();

  const CHUNK_SIZE = 90;
  for (let i = 0; i < taskIds.length; i += CHUNK_SIZE) {
    const chunk = taskIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const historyRows = await d1All(`
      SELECT ticket_id, previous_status, new_status, changed_at
      FROM ticket_status_history
      WHERE ticket_id IN (${placeholders})
      ORDER BY changed_at ASC
    `, chunk, dbInstance);

    for (const row of historyRows) {
      if (!transitionsByTaskId.has(row.ticket_id)) {
        transitionsByTaskId.set(row.ticket_id, []);
      }
      transitionsByTaskId.get(row.ticket_id).push(row);
    }
  }

  tasks.forEach((t) => {
    const normStatus = normalizeStatus(t.status);
    const isDone = normStatus === 'DONE';

    if (isDone) {
      completedTickets++;

      const createdAt = new Date(t.created_at).getTime();
      const completedAt = t.completed_at ? new Date(t.completed_at).getTime() : new Date().getTime();

      // Lead Time: created_at to completed_at
      const leadTimeMs = Math.max(0, completedAt - createdAt);
      leadTimesDays.push(leadTimeMs / (1000 * 60 * 60 * 24));

      // Cycle Time: from first transition into an active work status (IN_PROGRESS, CODE_REVIEW, TESTING) to DONE
      const transitions = transitionsByTaskId.get(t.id) || [];
      let workStartTime = null;

      for (const tr of transitions) {
        const toNorm = normalizeStatus(tr.new_status);
        if (toNorm === 'IN_PROGRESS' || toNorm === 'CODE_REVIEW' || toNorm === 'TESTING') {
          workStartTime = new Date(tr.changed_at).getTime();
          break;
        }
      }

      if (workStartTime) {
        const cycleTimeMs = Math.max(0, completedAt - workStartTime);
        cycleTimesDays.push(cycleTimeMs / (1000 * 60 * 60 * 24));
      } else {
        // Fallback to lead time if direct creation into completed
        cycleTimesDays.push(leadTimeMs / (1000 * 60 * 60 * 24));
      }
    } else if (normStatus === 'IN_PROGRESS' || normStatus === 'CODE_REVIEW' || normStatus === 'TESTING') {
      wipTickets++;
    }
  });

  // Calculate averages
  const avgCycleTime = cycleTimesDays.length > 0
    ? Number((cycleTimesDays.reduce((a, b) => a + b, 0) / cycleTimesDays.length).toFixed(1))
    : 0;

  const avgLeadTime = leadTimesDays.length > 0
    ? Number((leadTimesDays.reduce((a, b) => a + b, 0) / leadTimesDays.length).toFixed(1))
    : 0;

  // Throughput: completed tickets over the timeline window
  const timeline = cfdData.timeline || [];
  const daysInWindow = Math.max(1, timeline.length);
  const throughputPerDay = Number((completedTickets / daysInWindow).toFixed(2));
  const throughputPerWeek = Number((throughputPerDay * 7).toFixed(1));

  // Determine bottleneck indicator
  const bottlenecks = await getCFDBottlenecks({ workspaceId, query, d1 });
  const primaryBottleneck = bottlenecks.primary || {
    stage: 'Optimal Flow',
    isBottleneck: false,
    severity: 'NORMAL',
    accumulatedCount: 0,
    avgDwellTimeDays: 0,
    message: 'Work is flowing evenly across all stages with no critical queue accumulation.',
  };

  return {
    totalTickets,
    wip: wipTickets,
    completedTickets,
    throughput: {
      daily: throughputPerDay,
      weekly: throughputPerWeek,
      totalCompleted: completedTickets,
      windowDays: daysInWindow,
    },
    avgCycleTimeDays: avgCycleTime,
    avgLeadTimeDays: avgLeadTime,
    bottleneck: primaryBottleneck,
  };
}

/**
 * Automated Bottleneck Detection & Process Diagnostics.
 */
export async function getCFDBottlenecks({ workspaceId, query, d1 }) {
  const dbInstance = d1 || getD1Database();
  const { whereSql, params } = buildCFDFilter(query, workspaceId);

  // Get all active tasks in progress stages
  const activeTasks = await d1All(`
    SELECT t.id, t.key, t.name, t.status, t.priority, t.created_at, t.updated_at,
           u.name as assignee_name, u.avatar_url as assignee_avatar
    FROM tasks t
    LEFT JOIN members m ON t.assignee_id = m.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE ${whereSql} AND t.status NOT IN ('DONE', 'RESOLVED', 'CLOSED', 'COMPLETED')
    ORDER BY t.created_at ASC
  `, params, dbInstance);

  const stagesToMonitor = ['TESTING', 'CODE_REVIEW', 'IN_PROGRESS'];
  const stageStats = {};

  stagesToMonitor.forEach((stage) => {
    stageStats[stage] = {
      stage,
      label: stage.replace(/_/g, ' '),
      tickets: [],
      totalDwellTimeMs: 0,
    };
  });

  const now = Date.now();

  for (const t of activeTasks) {
    const normStatus = normalizeStatus(t.status);
    if (stageStats[normStatus]) {
      // Find when ticket entered this status
      const lastTransition = await d1First(`
        SELECT changed_at FROM ticket_status_history 
        WHERE ticket_id = ? AND new_status = ? 
        ORDER BY changed_at DESC LIMIT 1
      `, [t.id, t.status], dbInstance);

      const enteredTime = lastTransition?.changed_at
        ? new Date(lastTransition.changed_at).getTime()
        : new Date(t.created_at).getTime();

      const dwellTimeMs = Math.max(0, now - enteredTime);
      const dwellDays = Number((dwellTimeMs / (1000 * 60 * 60 * 24)).toFixed(1));

      stageStats[normStatus].totalDwellTimeMs += dwellTimeMs;
      stageStats[normStatus].tickets.push({
        id: t.id,
        key: t.key || 'TASK',
        name: t.name,
        priority: t.priority || 'MEDIUM',
        assigneeName: t.assignee_name || 'Unassigned',
        assigneeAvatar: t.assignee_avatar,
        daysInStage: dwellDays,
        enteredAt: lastTransition?.changed_at || t.created_at,
      });
    }
  }

  let highestScore = 0;
  let primaryBottleneck = null;
  const stageSummaries = [];

  Object.values(stageStats).forEach((item) => {
    const count = item.tickets.length;
    const avgDwellDays = count > 0
      ? Number(((item.totalDwellTimeMs / count) / (1000 * 60 * 60 * 24)).toFixed(1))
      : 0;

    // Bottleneck score combines volume and dwell duration
    const score = count * avgDwellDays;
    const isBottleneck = count >= 3 && avgDwellDays >= 2.0;
    const severity = count >= 6 || avgDwellDays >= 4.0 ? 'CRITICAL' : (isBottleneck ? 'WARNING' : 'NORMAL');

    // Sort tickets by longest waiting
    item.tickets.sort((a, b) => b.daysInStage - a.daysInStage);

    let recommendation = 'Flow in this stage is stable within healthy operational capacity.';
    if (item.stage === 'TESTING' && isBottleneck) {
      recommendation = 'QA verification queue is growing faster than throughput. Consider allocating dedicated test engineers to verify completed PRs and clear verification backlog.';
    } else if (item.stage === 'CODE_REVIEW' && isBottleneck) {
      recommendation = 'Pull requests are idling in Code Review. Enforce a 24-hour review SLA or designate peer review pairing hours.';
    } else if (item.stage === 'IN_PROGRESS' && isBottleneck) {
      recommendation = 'High Work In Progress (WIP) relative to completion rate. Apply WIP capacity limits in workflow stages to stop starting and start finishing.';
    }

    const summary = {
      stage: item.stage,
      label: item.label,
      isBottleneck,
      severity,
      accumulatedCount: count,
      avgDwellTimeDays: avgDwellDays,
      score,
      affectedTickets: item.tickets.slice(0, 10),
      recommendation,
    };

    stageSummaries.push(summary);

    if (score > highestScore && isBottleneck) {
      highestScore = score;
      primaryBottleneck = summary;
    }
  });

  return {
    primary: primaryBottleneck || {
      stage: 'Healthy Flow',
      isBottleneck: false,
      severity: 'NORMAL',
      accumulatedCount: 0,
      avgDwellTimeDays: 0,
      message: 'Workflow velocity is balanced. No critical bottlenecks detected across active stages.',
    },
    stages: stageSummaries,
  };
}

/**
 * Historical Ticket Drill-Down: List tickets in a status on a specific date.
 */
export async function getCFDTicketsDrilldown({ workspaceId, query, d1 }) {
  const dbInstance = d1 || getD1Database();
  const { whereSql, params } = buildCFDFilter(query, workspaceId);

  const targetDateStr = query.date || new Date().toISOString().slice(0, 10);
  const targetStatus = normalizeStatus(query.status || 'IN_PROGRESS');

  const evalDate = new Date(targetDateStr);
  evalDate.setUTCHours(23, 59, 59, 999);
  const evalTimestamp = evalDate.getTime();

  // Retrieve matching tasks
  const tasks = await d1All(`
    SELECT t.id, t.key, t.name, t.status, t.priority, t.created_at, t.completed_at, t.project_id,
           p.name as project_name, p.key as project_key,
           u.name as assignee_name, u.avatar_url as assignee_avatar
    FROM tasks t
    LEFT JOIN projects p ON t.project_id = p.id
    LEFT JOIN members m ON t.assignee_id = m.id
    LEFT JOIN users u ON m.user_id = u.id
    WHERE ${whereSql}
  `, params, dbInstance);

  const matchingTickets = [];

  for (const t of tasks) {
    const createdAtMs = new Date(t.created_at).getTime();
    if (createdAtMs > evalTimestamp) continue;

    // Find the latest transition on or before evalTimestamp
    const lastTransition = await d1First(`
      SELECT new_status, changed_at FROM ticket_status_history
      WHERE ticket_id = ? AND changed_at <= ?
      ORDER BY changed_at DESC LIMIT 1
    `, [t.id, evalDate.toISOString()], dbInstance);

    const statusAtDate = lastTransition
      ? normalizeStatus(lastTransition.new_status)
      : normalizeStatus(t.status);

    if (statusAtDate === targetStatus) {
      const enteredAt = lastTransition?.changed_at || t.created_at;
      const dwellMs = Math.max(0, evalTimestamp - new Date(enteredAt).getTime());
      const daysInStage = Number((dwellMs / (1000 * 60 * 60 * 24)).toFixed(1));

      matchingTickets.push({
        id: t.id,
        key: t.key || 'TASK',
        name: t.name,
        status: statusAtDate,
        currentStatus: t.status,
        priority: t.priority || 'MEDIUM',
        projectId: t.project_id,
        projectName: t.project_name || 'Project',
        projectKey: t.project_key || 'PROJ',
        assigneeName: t.assignee_name || 'Unassigned',
        assigneeAvatar: t.assignee_avatar,
        createdAt: t.created_at,
        statusEntryDate: enteredAt,
        daysInStage,
      });
    }
  }

  // Sort by days in stage descending (longest waiting first)
  matchingTickets.sort((a, b) => b.daysInStage - a.daysInStage);

  return {
    date: targetDateStr,
    status: targetStatus,
    count: matchingTickets.length,
    tickets: matchingTickets,
  };
}
