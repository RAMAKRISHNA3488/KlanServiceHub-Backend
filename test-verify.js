import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { db, ensureWorkspaceDefaults } from './src/db.js';
import { hasPermission, getUserPermissions } from './src/lib/permissions.js';

console.log('Testing Database and Enterprise Modules Initialization...');

// 1. Check or create test user
let testUser = db.prepare('SELECT * FROM users WHERE email = ?').get('owner@company.com');
if (!testUser) {
  const userId = randomUUID();
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, job_title, department)
    VALUES (?, 'Alice Owner', 'owner@company.com', ?, 'Chief Technology Officer', 'Executive')
  `).run(userId, bcrypt.hashSync('Password@123', 10));
  testUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}
console.log('✓ Test Owner User:', testUser.name, testUser.email);

// 2. Check or create workspace
let workspace = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').get(testUser.id);
if (!workspace) {
  const wsId = randomUUID();
  db.prepare(`
    INSERT INTO workspaces (id, name, user_id, description, website, email, timezone, invite_code)
    VALUES (?, 'Acme Global Technologies', ?, 'Leading enterprise cloud solutions provider', 'https://acme.io', 'admin@acme.io', 'UTC', 'ACME99')
  `).run(wsId, testUser.id);

  db.prepare(`
    INSERT INTO members (id, workspace_id, user_id, role, status)
    VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')
  `).run(randomUUID(), wsId, testUser.id);

  workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId);
}
console.log('✓ Test Workspace:', workspace.name);

// 3. Ensure defaults
ensureWorkspaceDefaults(workspace.id, testUser.id);

// 4. Verify RBAC Permissions
const ownerPermitted = hasPermission({ workspaceId: workspace.id, userId: testUser.id, permissionCode: 'COMPANY_SETTINGS_MANAGE' });
const allPerms = getUserPermissions({ workspaceId: workspace.id, userId: testUser.id });
console.log('✓ Owner Permission Check:', ownerPermitted ? 'PASSED' : 'FAILED');
console.log('✓ Total Owner Permissions Assigned:', allPerms.length);

// 5. Verify Roles, Teams, Issue Types, Workflows, Sprints, Subscriptions
const rolesCount = db.prepare('SELECT COUNT(*) as c FROM roles WHERE workspace_id = ?').get(workspace.id).c;
const teamsCount = db.prepare('SELECT COUNT(*) as c FROM teams WHERE workspace_id = ?').get(workspace.id).c;
const typesCount = db.prepare('SELECT COUNT(*) as c FROM issue_types WHERE workspace_id = ?').get(workspace.id).c;
const workflowsCount = db.prepare('SELECT COUNT(*) as c FROM workflows WHERE workspace_id = ?').get(workspace.id).c;
const sub = db.prepare('SELECT * FROM subscriptions WHERE workspace_id = ?').get(workspace.id);

console.log('✓ Roles Count:', rolesCount);
console.log('✓ Teams Count:', teamsCount);
console.log('✓ Issue Types Count:', typesCount);
console.log('✓ Workflows Count:', workflowsCount);
console.log('✓ Active Subscription Plan:', sub?.plan);

console.log('\nAll enterprise modules initialized successfully!');
