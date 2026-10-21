-- =======================================================================
-- KLANSERVICEHUB — CLOUDFLARE D1 UPDATE & UNIFICATION SCRIPT
-- Unifies 'CODE_REVIEW' and 'IN_REVIEW' into 'IN_REVIEW' across all tables,
-- and ensures all latest feature tables & indexes are active.
--
-- Execute via Wrangler CLI:
-- npx wrangler d1 execute klanservicehub_db --file=./cloudflare-migration-in-review-unification.sql --remote
-- =======================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------
-- 1. UNIFY STATUSES IN EXISTING DATA
-- -----------------------------------------------------------------------

-- A. Migrate any tasks currently in 'CODE_REVIEW' to 'IN_REVIEW'
UPDATE tasks 
SET status = 'IN_REVIEW' 
WHERE status IN ('CODE_REVIEW', 'Code Review', 'REVIEW', 'Review');

-- B. Unify workflow statuses definition table
UPDATE workflow_statuses 
SET name = 'IN_REVIEW' 
WHERE name IN ('CODE_REVIEW', 'Code Review');

-- C. Remove duplicate IN_REVIEW status rows within the same workflow if both existed
DELETE FROM workflow_statuses
WHERE id NOT IN (
  SELECT MIN(id) 
  FROM workflow_statuses 
  GROUP BY workflow_id, name
);

-- D. Update any Board JSON configurations that mapped CODE_REVIEW
UPDATE boards 
SET config = REPLACE(config, '"CODE_REVIEW"', '"IN_REVIEW"')
WHERE config LIKE '%CODE_REVIEW%';

UPDATE boards 
SET config = REPLACE(config, '"Code Review"', '"In Review"')
WHERE config LIKE '%Code Review%';

-- -----------------------------------------------------------------------
-- 2. ENSURE ALL CORE & LATEST TABLES EXIST
-- -----------------------------------------------------------------------

-- Multi-Assignees Junction Table (Assign multiple team members to a task)
CREATE TABLE IF NOT EXISTS task_assignees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_task_assignees ON task_assignees(task_id, member_id);

-- Task Comments Table (Real-time comments with edit & delete)
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);

-- Activities Table (Organization Activity Feed)
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  details TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_activities_ws_created ON activities(workspace_id, created_at DESC);

-- Teams & Squads (Reports & Capacity Workload)
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

-- Audit Logs Table
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
