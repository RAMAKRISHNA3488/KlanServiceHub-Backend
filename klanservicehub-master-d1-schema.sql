-- ==============================================================================
-- KLANSERVICEHUB MASTER CLOUDFLARE D1 / SQLITE SCHEMA (LATEST & COMPLETE)
-- Database Name: klanservicehub_db
-- Database ID:   e4065dbf-b85b-4d17-8334-f07f19109c70
-- Total Tables:  42
-- ==============================================================================

PRAGMA foreign_keys = ON;

-- ==============================================================================
-- 1. AUTHENTICATION, IDENTITY & ACCESS
-- ==============================================================================

-- 1.1 Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  phone TEXT,
  job_title TEXT,
  department TEXT,
  onboarding_status TEXT DEFAULT 'COMPLETED',
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, DEACTIVATED
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1.2 User Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret TEXT UNIQUE NOT NULL,
  ip_address TEXT DEFAULT '127.0.0.1',
  user_agent TEXT DEFAULT 'Web Browser',
  device_info TEXT DEFAULT 'Desktop Device',
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1.3 Email OTP Verifications
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 1.4 Password Resets
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at DATETIME NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  used INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 2. WORKSPACES, ORGANIZATIONS & TEAMS
-- ==============================================================================

-- 2.1 Workspaces (Companies)
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id TEXT,
  image_url TEXT,
  description TEXT DEFAULT '',
  website TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  country TEXT DEFAULT 'India',
  industry TEXT DEFAULT 'Software Development',
  company_size TEXT DEFAULT '51-200',
  domain_slug TEXT DEFAULT '',
  timezone TEXT DEFAULT 'Asia/Kolkata',
  language TEXT DEFAULT 'en-US',
  date_format TEXT DEFAULT 'YYYY-MM-DD',
  currency TEXT DEFAULT 'INR',
  status TEXT DEFAULT 'ACTIVE',
  invite_code TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2.2 Workspace Members
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  organization_role TEXT DEFAULT 'MEMBER',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id)
);

-- 2.3 Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2.4 Team Members
CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

-- 2.5 Team Projects
CREATE TABLE IF NOT EXISTS team_projects (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, project_id)
);

-- ==============================================================================
-- 3. RBAC, ROLES & PERMISSIONS
-- ==============================================================================

-- 3.1 Permissions
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT
);

-- 3.2 Roles
CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_system INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name)
);

-- 3.3 Role Permissions
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

-- 3.4 User Roles
CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id, role_id)
);

-- ==============================================================================
-- 4. PROJECTS, SPRINTS & WORKFLOWS
-- ==============================================================================

-- 4.1 Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT DEFAULT 'PROJ',
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'Software',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  lead_name TEXT DEFAULT '',
  methodology TEXT DEFAULT 'Scrum',
  image_id TEXT,
  image_url TEXT,
  is_archived INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4.2 Project Members
CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);

-- 4.3 Issue Types
CREATE TABLE IF NOT EXISTS issue_types (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'bookmark',
  color TEXT NOT NULL DEFAULT '#4F46E5',
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4.4 Workflows
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4.5 Workflow Statuses
CREATE TABLE IF NOT EXISTS workflow_statuses (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  color TEXT DEFAULT '#3B82F6',
  position INTEGER NOT NULL DEFAULT 0
);

-- 4.6 Workflow Transitions
CREATE TABLE IF NOT EXISTS workflow_transitions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_status_id TEXT,
  to_status_id TEXT NOT NULL,
  name TEXT NOT NULL
);

-- 4.7 Sprints
CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  goal TEXT DEFAULT '',
  start_date DATETIME,
  end_date DATETIME,
  status TEXT DEFAULT 'PLANNED',
  velocity INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 5. TASKS, MULTI-ASSIGNEES & DEPENDENCIES
-- ==============================================================================

-- 5.1 Tasks (Issues / Tickets)
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  epic_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'TODO',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  issue_type TEXT NOT NULL DEFAULT 'Task',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 1000,
  due_date DATETIME,
  start_date DATETIME,
  story_points INTEGER DEFAULT 0,
  estimated_hours REAL DEFAULT 0,
  spent_hours REAL DEFAULT 0,
  resolution TEXT,
  resolved_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5.2 Task Assignees (Multi-Assignee Support)
CREATE TABLE IF NOT EXISTS task_assignees (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, user_id)
);

-- 5.3 Task Watchers
CREATE TABLE IF NOT EXISTS task_watchers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, user_id)
);

-- 5.4 Task Dependencies (Issue Links & Blockers)
CREATE TABLE IF NOT EXISTS task_dependencies (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT 'BLOCKS',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(task_id, depends_on_task_id, link_type)
);

-- 5.5 Task Attachments
CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  mime_type TEXT DEFAULT 'application/octet-stream',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5.6 Comments
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 6. AUDIT LOGGING & NOTIFICATIONS
-- ==============================================================================

-- 6.1 Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL DEFAULT 'System',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6.2 Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  type TEXT DEFAULT 'INFO',
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 7. SERVICE DESK, INCIDENTS & SLA MANAGEMENT
-- ==============================================================================

-- 7.1 Service Requests (Tickets)
CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Technical',
  priority TEXT NOT NULL DEFAULT 'MEDIUM',
  status TEXT NOT NULL DEFAULT 'OPEN',
  assigned_to TEXT REFERENCES users(id) ON DELETE SET NULL,
  sla_breached INTEGER DEFAULT 0,
  sla_due_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7.2 Service Request Comments
CREATE TABLE IF NOT EXISTS service_request_comments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_internal INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7.3 Service Request Attachments
CREATE TABLE IF NOT EXISTS service_request_attachments (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7.4 SLA Policies
CREATE TABLE IF NOT EXISTS sla_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  priority TEXT NOT NULL,
  response_time_minutes INTEGER NOT NULL DEFAULT 60,
  resolution_time_minutes INTEGER NOT NULL DEFAULT 240,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, priority)
);

-- 7.5 SLA Breaches
CREATE TABLE IF NOT EXISTS sla_breaches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  breach_type TEXT NOT NULL,
  breached_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 8. DASHBOARDS, GADGETS & CUSTOM FIELDS
-- ==============================================================================

-- 8.1 Dashboards
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  layout TEXT DEFAULT 'TWO_COLUMN',
  is_default INTEGER DEFAULT 0,
  is_shared INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8.2 Dashboard Gadgets
CREATE TABLE IF NOT EXISTS dashboard_gadgets (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  gadget_type TEXT NOT NULL,
  title TEXT NOT NULL,
  column_index INTEGER NOT NULL DEFAULT 0,
  row_index INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8.3 Custom Fields
CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options_json TEXT DEFAULT '[]',
  is_required INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 8.4 Custom Field Values
CREATE TABLE IF NOT EXISTS custom_field_values (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(field_id, task_id)
);

-- ==============================================================================
-- 9. WEBHOOKS, AUTOMATIONS & INVITATIONS
-- ==============================================================================

-- 9.1 Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  events TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9.2 Webhook Deliveries
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9.3 Automations
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  condition_json TEXT,
  action_json TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  execution_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9.4 Automation Logs
CREATE TABLE IF NOT EXISTS automation_logs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger_payload TEXT,
  action_result TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 9.5 Invitations
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_role TEXT NOT NULL DEFAULT 'MEMBER',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_role TEXT DEFAULT 'MEMBER',
  token_hash TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==============================================================================
-- 10. OPTIMIZED PERFORMANCE INDEXES
-- ==============================================================================

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_sessions_secret ON sessions(secret);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verif_email ON email_verifications(email);
CREATE INDEX IF NOT EXISTS idx_password_resets_email ON password_resets(email);
CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
CREATE INDEX IF NOT EXISTS idx_members_ws_user ON members(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_proj ON tasks(workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_sprint ON tasks(sprint_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_task_assignees_task ON task_assignees(task_id);
CREATE INDEX IF NOT EXISTS idx_task_assignees_user ON task_assignees(user_id);
CREATE INDEX IF NOT EXISTS idx_service_req_ws ON service_requests(workspace_id);
CREATE INDEX IF NOT EXISTS idx_service_req_status ON service_requests(status);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ws ON audit_logs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_org_email ON invitations(organization_id, email);
