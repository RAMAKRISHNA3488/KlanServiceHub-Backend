# KlanServiceHub — Database Tables & Schema Update Guide

This guide details all **database tables updated or utilized by today's features**, along with the exact commands to execute them on Cloudflare D1 or inspect them.

The raw SQL script is available in: [UPDATED_DATABASE_TABLES.sql](file:///c:/Users/ramak/Videos/Klanvision%20Projects/Ramakrishna3488%20-%20KlanserviceHub/UPDATED_DATABASE_TABLES.sql).

---

## 1. Summary of Updated & Utilized Tables

| Table Name | Associated Feature | What Was Updated / Ensured |
|---|---|---|
| **`activities`** | Organization Activity Feed | Added index `idx_activities_ws_created(workspace_id, created_at DESC)` and implemented 50-event rolling FIFO expiration. |
| **`tasks`** | Issue Details, Boards, Story Points | Ensured `story_points REAL DEFAULT 1`, `issue_type`, `priority`, `status`, and `sprint_id` columns and indexes are properly structured. |
| **`task_comments`** | Comments Inline Edit & Delete | Ensured `content TEXT` and `updated_at DATETIME` exist for live editing timestamps. |
| **`task_assignees`** | Multi-Assignees on Tasks | Verified junction table between `tasks` and `members`. |
| **`teams` & `team_members`** | Reports & Organization Analytics | Verified schemas for team overview cards and member workloads. |
| **`audit_logs`** | Security & Governance Audit Trail | Verified audit log schemas for administrative actions. |
| **`task_links`** | Ticket Linking & Dependencies | Added `description TEXT DEFAULT ''`, `updated_at DATETIME`, and bidirectional indexing for 7 relationship types with cycle detection. |

---

## 2. Table Definitions

### 📌 Table 1: `activities` (Organization Activity Feed)
Stores rolling organization activity events (max 50 events per workspace).
```sql
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
```

### 📌 Table 2: `task_comments` (Issue Comments)
Supports adding, editing, and deleting comments with timestamps.
```sql
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);
```

### 📌 Table 3: `tasks` (Issues & Work Items)
Key columns for today's features: `story_points`, `issue_type`, `sprint_id`, `priority`, `status`.
```sql
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
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  status TEXT NOT NULL DEFAULT 'TODO',
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
```

### 📌 Table 4: `teams` & `team_members` (Reports & Analytics)
```sql
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
```

### 📌 Table 5: `task_links` (Ticket Relationships & Dependencies)
Manages 7 bidirectional relationship types, blocking cycle detection, and blocker tracking.
```sql
CREATE TABLE IF NOT EXISTS task_links (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'relates to', -- blocks, is blocked by, relates to, duplicates, is duplicated by, clones, is cloned by
  description TEXT DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_task_id);
```

---

## 3. How to Execute / Apply on Cloudflare D1

To apply these tables and indexes to your remote Cloudflare D1 database:

### Command (from `backend/` directory):
```powershell
npx wrangler d1 execute klanservicehub_db --file=../UPDATED_DATABASE_TABLES.sql --remote
```

### Local Test Execution:
```powershell
npx wrangler d1 execute klanservicehub_db --file=../UPDATED_DATABASE_TABLES.sql --local
```

---

## 4. Verification Queries

Run these queries to verify that your tables and columns exist in D1:

1. **Verify Activities Count & Index**:
   ```sql
   SELECT COUNT(*) as total_activities FROM activities;
   ```

2. **Verify Story Points column on Tasks**:
   ```sql
   PRAGMA table_info(tasks);
   ```

3. **Verify Comments with timestamps**:
   ```sql
   PRAGMA table_info(task_comments);
   ```

4. **Verify Task Links schema & indexes**:
   ```sql
   PRAGMA table_info(task_links);
   PRAGMA index_list(task_links);
   ```
