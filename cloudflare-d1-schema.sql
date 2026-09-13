-- =======================================================================
-- CLOUDFLARE D1 / SQLITE MASTER SCHEMA FOR ENTERPRISE TICKETING PLATFORM
-- Single Master Database Schema File
-- =======================================================================

PRAGMA foreign_keys = ON;

-- 1. USERS & GLOBAL IDENTITY
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  phone TEXT,
  job_title TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, DEACTIVATED
  onboarding_status TEXT NOT NULL DEFAULT 'REGISTERED', -- REGISTERED, ACCOUNT_CREATED, ONBOARDING_COMPLETED
  display_name TEXT DEFAULT '',
  location TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  company_size TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. SESSIONS & DEVICE GOVERNANCE
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

-- 3. EMAIL OTP VERIFICATIONS
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. ORGANIZATIONS / WORKSPACES (COMPANY PROFILE)
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
  timezone TEXT DEFAULT 'UTC',
  language TEXT DEFAULT 'en-US',
  date_format TEXT DEFAULT 'YYYY-MM-DD',
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'ACTIVE', -- ACTIVE, INACTIVE, SUSPENDED
  domain_slug TEXT DEFAULT '',
  industry TEXT DEFAULT '',
  company_size TEXT DEFAULT '',
  country TEXT DEFAULT 'India',
  onboarding_completed INTEGER DEFAULT 1,
  invite_code TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 5. ORGANIZATION MEMBERSHIPS
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'MEMBER', -- OWNER, ADMIN, MEMBER
  organization_role TEXT NOT NULL DEFAULT 'MEMBER', -- COMPANY_OWNER, COMPANY_ADMIN, PROJECT_ADMIN, TECH_LEAD, DEVELOPER, QA_ENGINEER, PRODUCT_MANAGER, VIEWER
  status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, PENDING
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id)
);

-- 6. TOKEN-BASED INVITATIONS
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_role TEXT NOT NULL DEFAULT 'MEMBER',
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  project_role TEXT DEFAULT 'MEMBER',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, ACCEPTED, DECLINED, EXPIRED, REVOKED
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 7. SYSTEM & GRANULAR RBAC PERMISSIONS (72 PERMISSIONS)
CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- COMPANY, PROJECT, ISSUE, etc.
  description TEXT
);

-- 8. WORKSPACE ROLES
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

-- 9. ROLE TO PERMISSION MAPPINGS
CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code TEXT NOT NULL,
  PRIMARY KEY (role_id, permission_code)
);

-- 10. USER TO ROLE ASSIGNMENTS
CREATE TABLE IF NOT EXISTS user_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, user_id, role_id)
);

-- 11. USER ACCESS GROUPS (ATLASSIAN USER GROUPS)
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id)
);

-- 12. TEAMS & SQUADS
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
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_projects (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, project_id)
);

-- 13. PROJECTS
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key TEXT DEFAULT 'PROJ',
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'Software',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  image_id TEXT,
  image_url TEXT,
  is_archived INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 14. PROJECT MEMBERS
CREATE TABLE IF NOT EXISTS project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, user_id)
);

-- 15. ISSUE TYPES
CREATE TABLE IF NOT EXISTS issue_types (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'bookmark',
  color TEXT NOT NULL DEFAULT '#4F46E5',
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 16. WORKFLOWS, STATUSES & TRANSITIONS
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_default INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_statuses (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'IN_PROGRESS', -- TODO, IN_PROGRESS, DONE
  color TEXT DEFAULT '#3B82F6',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_transitions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_status_id TEXT,
  to_status_id TEXT NOT NULL,
  name TEXT NOT NULL
);

-- 17. SPRINTS
CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  goal TEXT DEFAULT '',
  start_date DATETIME,
  end_date DATETIME,
  status TEXT NOT NULL DEFAULT 'FUTURE', -- FUTURE, ACTIVE, CLOSED
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 18. BOARDS
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'KANBAN', -- KANBAN, SCRUM
  config TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 19. RELEASES & VERSIONS
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  release_date DATETIME,
  status TEXT NOT NULL DEFAULT 'UNRELEASED', -- UNRELEASED, RELEASED, ARCHIVED
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 20. ISSUES / TASKS
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
  release_id TEXT,
  original_estimate_hours REAL DEFAULT 0,
  logged_hours REAL DEFAULT 0,
  components TEXT DEFAULT '[]',
  due_date DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 21. ISSUE COMMENTS & ATTACHMENTS & WATCHERS
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_watchers (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE IF NOT EXISTS task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_attachments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_size INTEGER DEFAULT 0,
  file_type TEXT DEFAULT 'application/octet-stream',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 22. ISSUE LINKS & RELATIONSHIPS
CREATE TABLE IF NOT EXISTS task_links (
  id TEXT PRIMARY KEY,
  source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL DEFAULT 'relates to', -- blocks, is blocked by, relates to, duplicates, is duplicated by
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 23. ACTIVITIES & WORK LOGS
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

CREATE TABLE IF NOT EXISTS work_logs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  time_spent_seconds INTEGER NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  description TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_components (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  lead_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  default_assignee TEXT DEFAULT 'PROJECT_LEAD',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  jql_query TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'PRIVATE',
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 24. CUSTOM FIELDS & VALUES
CREATE TABLE IF NOT EXISTS custom_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  field_type TEXT NOT NULL DEFAULT 'TEXT',
  required INTEGER DEFAULT 0,
  default_value TEXT,
  options TEXT DEFAULT '[]',
  created_by TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_custom_field_values (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  custom_field_id TEXT NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  field_value TEXT,
  PRIMARY KEY (task_id, custom_field_id)
);

-- 25. SCHEMES & SLA
CREATE TABLE IF NOT EXISTS issue_type_schemes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  default_issue_type TEXT DEFAULT 'Task',
  issue_types TEXT DEFAULT '["Epic","Story","Task","Bug","Sub-task"]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS priority_schemes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  default_priority TEXT DEFAULT 'MEDIUM',
  priorities TEXT DEFAULT '["LOWEST","LOW","MEDIUM","HIGH","HIGHEST","CRITICAL"]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sla_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_minutes INTEGER NOT NULL DEFAULT 240,
  calendar TEXT DEFAULT 'BUSINESS_HOURS',
  priority TEXT DEFAULT 'HIGH',
  status TEXT DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sla_records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sla_id TEXT NOT NULL REFERENCES sla_definitions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING',
  target_minutes INTEGER NOT NULL,
  elapsed_minutes INTEGER DEFAULT 0,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  breached_at DATETIME
);

-- 26. WEBHOOKS & DELIVERIES
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '["ISSUE_CREATED","ISSUE_UPDATED","ISSUE_STATUS_CHANGED"]',
  secret TEXT NOT NULL,
  status TEXT DEFAULT 'ACTIVE',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  response_code INTEGER,
  payload TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 27. USER FAVORITES & RECENT ITEMS
CREATE TABLE IF NOT EXISTS user_favorites (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, entity_type, entity_id)
);

CREATE TABLE IF NOT EXISTS user_recent_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 28. DOMAIN OUTBOX EVENTS
CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME
);

-- 29. RELEASE TRAINS & CAPACITIES
CREATE TABLE IF NOT EXISTS release_trains (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_date DATETIME,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  release_manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS release_train_versions (
  release_train_id TEXT NOT NULL REFERENCES release_trains(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (release_train_id, version_id)
);

CREATE TABLE IF NOT EXISTS team_capacities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  working_hours_per_day REAL DEFAULT 8.0,
  availability_percentage REAL DEFAULT 100.0,
  capacity_hours REAL DEFAULT 40.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  start_at DATETIME NOT NULL,
  end_at DATETIME NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'CONFIRMED',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 30. PROJECT GOVERNANCE: MILESTONES, RISKS, DECISIONS & APPROVALS
CREATE TABLE IF NOT EXISTS project_milestones (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_date DATETIME NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_risks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  probability TEXT NOT NULL DEFAULT 'MEDIUM',
  impact TEXT NOT NULL DEFAULT 'MEDIUM',
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  mitigation TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_date DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  decision TEXT NOT NULL,
  reason TEXT DEFAULT '',
  decided_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'APPROVED',
  decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  reason TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME
);

CREATE TABLE IF NOT EXISTS change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  reason TEXT DEFAULT '',
  impact TEXT DEFAULT 'LOW',
  risk TEXT DEFAULT 'LOW',
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 31. JIRA SERVICE MANAGEMENT (JSM) / KSM & CUSTOMER ORGANIZATIONS
CREATE TABLE IF NOT EXISTS service_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL DEFAULT 'SERVICE_REQUEST', -- INCIDENT, SERVICE_REQUEST, CHANGE, PROBLEM, QUESTION
  summary TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, IN_PROGRESS, WAITING_FOR_CUSTOMER, PENDING_APPROVAL, RESOLVED, CLOSED
  queue_name TEXT DEFAULT 'General Triage',
  priority TEXT DEFAULT 'MEDIUM', -- CRITICAL, HIGH, MEDIUM, LOW
  sla_due_at DATETIME,
  sla_first_response_due_at DATETIME,
  sla_breached INTEGER DEFAULT 0,
  resolved_at DATETIME,
  satisfaction_rating INTEGER, -- 1 to 5 stars
  assigned_agent_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_org_id TEXT REFERENCES customer_organizations(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_organizations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  domains TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 32. CMDB ASSETS & INFRASTRUCTURE TOPOLOGY
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  environment TEXT DEFAULT 'PRODUCTION',
  location TEXT DEFAULT 'AWS us-east-1',
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_dependencies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  target_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  relationship TEXT DEFAULT 'depends on',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 33. ENVIRONMENTS & DEPLOYMENTS (DORA METRICS)
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PRODUCTION',
  status TEXT DEFAULT 'HEALTHY',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SUCCESS',
  deployed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 34. STRATEGIC PORTFOLIOS, INITIATIVES & GOALS
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS portfolio_projects (
  portfolio_id TEXT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (portfolio_id, project_id)
);

CREATE TABLE IF NOT EXISTS initiatives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  portfolio_id TEXT REFERENCES portfolios(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_date DATETIME,
  status TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS strategic_goals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  target_date DATETIME,
  status TEXT NOT NULL DEFAULT 'ON_TRACK',
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 35. AUTOMATIONS
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  trigger_event TEXT NOT NULL,
  conditions TEXT DEFAULT '[]',
  actions TEXT DEFAULT '[]',
  is_active INTEGER DEFAULT 1,
  execution_count INTEGER DEFAULT 0,
  last_run_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT,
  executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 36. NOTIFICATIONS & PREFERENCES
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

CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email_alerts INTEGER DEFAULT 1,
  in_app_alerts INTEGER DEFAULT 1,
  mention_alerts INTEGER DEFAULT 1,
  assignment_alerts INTEGER DEFAULT 1,
  status_change_alerts INTEGER DEFAULT 1,
  PRIMARY KEY (user_id, workspace_id)
);

-- 37. INTEGRATIONS & TOKENS
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'CONNECTED',
  last_sync_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS integration_logs (
  id TEXT PRIMARY KEY,
  integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  status TEXT NOT NULL,
  payload TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT DEFAULT '["*"]',
  expires_at DATETIME,
  last_used_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 38. SECURITY POLICIES & AUDIT LOGS
CREATE TABLE IF NOT EXISTS security_policies (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  min_password_length INTEGER DEFAULT 8,
  require_special_char INTEGER DEFAULT 1,
  require_numbers INTEGER DEFAULT 1,
  session_timeout_mins INTEGER DEFAULT 1440,
  mfa_required INTEGER DEFAULT 0,
  ip_allowlist TEXT DEFAULT '',
  sso_enabled INTEGER DEFAULT 0,
  sso_provider TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

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

-- 39. BILLING, INVOICES & BACKUPS
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT UNIQUE NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'BUSINESS',
  billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
  user_limit INTEGER DEFAULT 100,
  project_limit INTEGER DEFAULT -1,
  storage_limit_gb INTEGER DEFAULT 500,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  current_period_end DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'PAID',
  invoice_date DATETIME NOT NULL,
  pdf_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- =======================================================================
-- 40. PERFORMANCE INDEXES
-- =======================================================================
CREATE INDEX IF NOT EXISTS idx_invitations_token ON invitations(token_hash);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(group_id, user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_ws_proj ON tasks(workspace_id, project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_key ON tasks(key);
CREATE INDEX IF NOT EXISTS idx_task_links_source ON task_links(source_task_id);
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_task_id);
CREATE INDEX IF NOT EXISTS idx_task_history ON task_history(task_id);
CREATE INDEX IF NOT EXISTS idx_work_logs_task ON work_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_custom_field_values ON task_custom_field_values(task_id, custom_field_id);
CREATE INDEX IF NOT EXISTS idx_activities_ws ON activities(workspace_id);
CREATE INDEX IF NOT EXISTS idx_user_favs ON user_favorites(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_deployments_proj ON deployments(project_id, environment);
CREATE INDEX IF NOT EXISTS idx_service_reqs_ws ON service_requests(workspace_id, status);
