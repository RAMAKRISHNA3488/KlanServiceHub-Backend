-- =======================================================================
-- KLANSERVICEHUB V1 — CLOUDFLARE D1 DATABASE TABLES & MIGRATION SCRIPT
-- =======================================================================
-- Execution Command (from the backend/ directory):
-- npx wrangler d1 execute klanservicehub_db --file=./UPDATED_DATABASE_TABLES.sql --remote
-- =======================================================================

PRAGMA foreign_keys = ON;

-- =======================================================================
-- 1. TASK COMMENTS TABLE (With Full Date & Time Timestamps)
-- =======================================================================
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);

-- =======================================================================
-- 2. TASKS / TICKETS TABLE (Full Fields, Story Points & Timestamps)
-- =======================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assignee_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  issue_type TEXT NOT NULL DEFAULT 'Task',
  key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  priority TEXT NOT NULL DEFAULT 'MEDIUM', -- LOWEST, LOW, MEDIUM, HIGH, HIGHEST, CRITICAL
  status TEXT NOT NULL DEFAULT 'TODO', -- BACKLOG, TODO, IN_PROGRESS, IN_REVIEW, DONE
  position INTEGER NOT NULL DEFAULT 1000,
  labels TEXT DEFAULT '[]',
  story_points REAL DEFAULT 1,
  epic_id TEXT,
  parent_task_id TEXT,
  original_estimate_hours REAL DEFAULT 0,
  logged_hours REAL DEFAULT 0,
  due_date DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tasks_ws_proj ON tasks(workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);

-- 4. MULTI-ASSIGNEES JUNCTION TABLE
CREATE TABLE IF NOT EXISTS task_assignees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_task_assignees ON task_assignees(task_id, member_id);

-- 5. TEAMS & SQUADS (Used for Reports & Organization Analytics)
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_teams_ws ON teams(workspace_id);

-- 6. AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  ip_address TEXT DEFAULT '127.0.0.1',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_ws ON audit_logs(workspace_id, created_at DESC);

-- =======================================================================
-- ONE-TIME EXPIRATION / PRUNING CLEANUP FOR ACTIVITIES (50 EVENT LIMIT)
-- =======================================================================
DELETE FROM activities
WHERE id IN (
  SELECT a1.id
  FROM activities a1
  WHERE (
    SELECT COUNT(*)
    FROM activities a2
    WHERE a2.workspace_id = a1.workspace_id
      AND a2.created_at >= a1.created_at
  ) > 50
);
