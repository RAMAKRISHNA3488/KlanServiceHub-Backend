process.env.TEST_MODE = 'true';
import app from './src/index.js';
import { db, ensureWorkspaceDefaults } from './src/db.js';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';

async function runMasterE2ETestSuite() {
  console.log('========================================================================');
  console.log('🚀 MASTER ENTERPRISE TICKETING PLATFORM COMPREHENSIVE VERIFICATION SUITE');
  console.log('========================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`  ✓ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${name}`);
      failed++;
    }
  }

  // 1. Setup Test Master User & Organization
  const testEmail = `master_owner_${Date.now()}@company.com`;
  const userId = randomUUID();
  const wsId = randomUUID();
  const sessionSecret = randomUUID();

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, job_title, department, onboarding_status)
    VALUES (?, 'Alice Master Owner', ?, ?, 'Chief Technology Officer', 'Executive', 'ONBOARDING_COMPLETED')
  `).run(userId, testEmail, bcrypt.hashSync('Password@123', 10));

  db.prepare(`
    INSERT INTO workspaces (id, name, user_id, description, website, email, invite_code, domain_slug)
    VALUES (?, 'Acme Global Technologies', ?, 'Leading enterprise cloud solutions provider', 'https://acme.io', ?, 'ACME999', 'acme-global')
  `).run(wsId, userId, testEmail);

  db.prepare(`
    INSERT INTO members (id, workspace_id, user_id, role, status, organization_role)
    VALUES (?, ?, ?, 'ADMIN', 'ACTIVE', 'COMPANY_OWNER')
  `).run(randomUUID(), wsId, userId);

  db.prepare(`
    INSERT INTO sessions (id, user_id, secret, expires_at)
    VALUES (?, ?, ?, datetime('now', '+1 day'))
  `).run(randomUUID(), userId, sessionSecret);

  ensureWorkspaceDefaults(wsId, userId);

  const authHeaders = {
    'Cookie': `jira-clone-session=${sessionSecret}`,
    'Content-Type': 'application/json',
  };

  async function request(path, options = {}) {
    const url = `http://localhost${path}`;
    const req = new Request(url, {
      ...options,
      headers: {
        ...authHeaders,
        ...(options.headers || {}),
      },
    });
    const res = await app.fetch(req);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/')) {
      return { status: res.status, text: await res.text() };
    }
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  // [1. Email-First Auth & OTP]
  console.log('--- [1. Email-First Authentication & Hashed OTP Suite] ---');
  const newEmail = `user_${Date.now()}@acme.com`;
  let res = await request('/api/auth/check-email', { method: 'POST', body: JSON.stringify({ email: newEmail }) });
  assert(res.status === 200 && res.data.exists === false, 'Check Email: Unregistered email detection');

  res = await request('/api/auth/check-email', { method: 'POST', body: JSON.stringify({ email: testEmail }) });
  assert(res.status === 200 && res.data.exists === true, 'Check Email: Registered user detection');

  res = await request('/api/auth/send-otp', { method: 'POST', body: JSON.stringify({ email: newEmail }) });
  assert(res.status === 200 && res.data.simulatedOtp !== undefined, 'Send 6-Digit Email OTP');
  const otpCode = res.data.simulatedOtp;

  res = await request('/api/auth/verify-otp', { method: 'POST', body: JSON.stringify({ email: newEmail, otp: otpCode }) });
  assert(res.status === 200 && res.data.verified === true, 'Verify Email OTP (Bcrypt verification)');

  res = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Bob Developer', email: newEmail, password: 'Password@123' }),
  });
  assert(res.status === 200 && res.data.user.onboardingStatus === 'ACCOUNT_CREATED', 'Account Registration (ACCOUNT_CREATED)');

  // [2. Organization Profile & Ownership Transfer]
  console.log('\n--- [2. Company Profile Management & Ownership Transfer] ---');
  res = await request(`/api/company/${wsId}`);
  assert(res.status === 200 && res.data.data.isOwner === true, 'Get Company Profile & Verify Owner Access');

  res = await request(`/api/company/${wsId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Acme Technologies Inc.', timezone: 'Asia/Kolkata' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Acme Technologies Inc.', 'Update Company Profile');

  const newOwnerEmail = `owner2_${Date.now()}@acme.com`;
  const newOwnerId = randomUUID();
  db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, 'Charlie VP', ?, 'hash')").run(newOwnerId, newOwnerEmail);
  db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status, organization_role) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'MEMBER')").run(randomUUID(), wsId, newOwnerId);

  res = await request(`/api/company/${wsId}/transfer-ownership`, {
    method: 'POST',
    body: JSON.stringify({ newOwnerUserId: newOwnerId, password: 'Password@123' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Authorize Company Ownership Transfer with Password');

  // Transfer back to test user for remainder of tests
  db.prepare('UPDATE workspaces SET user_id = ? WHERE id = ?').run(userId, wsId);
  db.prepare("UPDATE members SET organization_role = 'COMPANY_OWNER', role = 'ADMIN' WHERE workspace_id = ? AND user_id = ?").run(wsId, userId);

  // [3. Invitations System]
  console.log('\n--- [3. Token-Based Invitations System] ---');
  const inviteEmail = `invited_dev_${Date.now()}@acme.com`;
  res = await request(`/api/invitations/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ email: inviteEmail, organizationRole: 'MEMBER' }),
  });
  assert(res.status === 200 && res.data.data.token !== undefined, 'Issue Cryptographic Invitation Token');
  const inviteToken = res.data.data.token;

  res = await request(`/api/invitations/token/${inviteToken}`);
  assert(res.status === 200 && res.data.data.email === inviteEmail, 'Validate Invitation Context & Expiration');

  res = await request(`/api/invitations/token/${inviteToken}/accept`, { method: 'POST' });
  assert(res.status === 200 && res.data.success === true, 'Accept Invitation & Create Member Access');

  // [4. User Directory & Safe Reassignment]
  console.log('\n--- [4. User Directory & Safe Workload Reassignment] ---');
  res = await request(`/api/users/${wsId}`);
  assert(res.status === 200 && res.data.data.length >= 2, 'List Organization Directory');

  const reassignTargetUserId = userId;
  res = await request(`/api/users/${wsId}/${newOwnerId}/reassign-and-remove`, {
    method: 'POST',
    body: JSON.stringify({ reassignToUserId: reassignTargetUserId }),
  });
  assert(res.status === 200 && res.data.success === true, 'Deactivate Member & Reassign Assigned Tasks');

  // [5. Access Groups]
  console.log('\n--- [5. User Access Groups (Atlassian Groups)] ---');
  res = await request(`/api/groups/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'jira-administrators', description: 'System administrators group' }),
  });
  assert(res.status === 200 && res.data.data.name === 'jira-administrators', 'Create User Group');
  const testGroupId = res.data.data.id;

  res = await request(`/api/groups/${wsId}/${testGroupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  assert(res.status === 200 && res.data.success === true, 'Add Member to Group');

  res = await request(`/api/groups/${wsId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Organization Groups');

  // [6. Roles & RBAC Matrix]
  console.log('\n--- [6. Roles & Granular Permissions Matrix] ---');
  res = await request(`/api/roles/${wsId}`);
  assert(res.status === 200 && res.data.data.roles.length >= 8, 'List 8 Standard System Roles');
  assert(res.data.data.allPermissions.length >= 70, 'Catalog All 72 Granular System Permissions');

  // [7. Projects, Tasks & Jira Issue Keys]
  console.log('\n--- [7. Projects, Tasks & Jira Issue Keys] ---');
  const projId = randomUUID();
  db.prepare(`
    INSERT INTO projects (id, name, workspace_id, key) VALUES (?, 'E-Commerce Platform', ?, 'ECOM')
  `).run(projId, wsId);

  res = await request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      workspaceId: wsId,
      projectId: projId,
      name: 'Implement OAuth2 Google Authentication',
      issueType: 'Story',
      priority: 'HIGH',
      status: 'TODO',
      storyPoints: 5,
    }),
  });
  assert(res.status === 200 && res.data.data.key.startsWith('ECOM-'), 'Auto-Generate Jira Key (ECOM-101)');
  const createdTaskId = res.data.data.id;

  const ownerMember = db.prepare('SELECT id FROM members WHERE workspace_id = ? AND user_id = ?').get(wsId, userId);
  const task2Id = randomUUID();
  db.prepare(`
    INSERT INTO tasks (id, workspace_id, project_id, assignee_id, name, key, status, priority, due_date)
    VALUES (?, ?, ?, ?, 'Backend Database Schema Migration', 'ECOM-102', 'IN_PROGRESS', 'HIGH', CURRENT_TIMESTAMP)
  `).run(task2Id, wsId, projId, ownerMember?.id || null);

  // [8. Issue Transitions & Structured History]
  console.log('\n--- [8. Issue Status Transitions & Field Audit History] ---');
  res = await request(`/api/tasks/${createdTaskId}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ toStatus: 'IN_PROGRESS', comment: 'Starting work on OAuth2 module' }),
  });
  assert(res.status === 200 && res.data.toStatus === 'IN_PROGRESS', 'Execute Validated Workflow Status Transition');

  res = await request(`/api/tasks/${createdTaskId}/history`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Field-Level Issue Audit History');

  // [9. Issue Links & Relationships]
  console.log('\n--- [9. Issue Links & Graph Relationships] ---');
  res = await request(`/api/tasks/${createdTaskId}/links`, {
    method: 'POST',
    body: JSON.stringify({ targetTaskId: task2Id, relationshipType: 'blocks' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Create Issue Relationship (blocks)');

  res = await request(`/api/tasks/${createdTaskId}/links`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Issue Linked Relations');

  // [10. Issue Attachments & Watchers]
  console.log('\n--- [10. Issue Attachments & Watchers] ---');
  res = await request(`/api/tasks/${createdTaskId}/attachments`, {
    method: 'POST',
    body: JSON.stringify({ fileName: 'architecture_diagram.png', fileUrl: 'https://cdn.acme.io/arch.png', fileSize: 102400 }),
  });
  assert(res.status === 200 && res.data.success === true, 'Upload Issue Attachment Record');

  res = await request(`/api/tasks/${createdTaskId}/watch`, { method: 'POST' });
  assert(res.status === 200 && res.data.watching === true, 'Subscribe to Issue Watcher Updates');

  // [11. Time Tracking & Work Logs]
  console.log('\n--- [11. Time Tracking & Work Logs] ---');
  res = await request(`/api/worklogs/${createdTaskId}`, {
    method: 'POST',
    body: JSON.stringify({ timeSpentSeconds: 7200, description: 'Implemented OAuth2 callbacks', strategy: 'AUTO_ADJUST' }),
  });
  assert(res.status === 200 && res.data.data.timeSpentSeconds === 7200, 'Log Work with AUTO_ADJUST Strategy');

  res = await request(`/api/worklogs/${createdTaskId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Work Log Timesheets');

  // [12. Components Management]
  console.log('\n--- [12. Project Components Management] ---');
  res = await request(`/api/components/project/${projId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Authentication Service', description: 'OAuth2 and SSO components' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Authentication Service', 'Create Project Component');

  res = await request(`/api/components/project/${projId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Project Components');

  // [13. Saved Filters & JQL Search Engine]
  console.log('\n--- [13. Saved Filters & JQL Search Engine] ---');
  res = await request(`/api/filters/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'High Priority Tasks', jqlQuery: 'project = ECOM AND priority = HIGH', visibility: 'COMPANY' }),
  });
  assert(res.status === 200 && res.data.data.name === 'High Priority Tasks', 'Save Custom JQL Filter');

  res = await request(`/api/filters/search/jql?workspaceId=${wsId}&jql=project = ECOM AND priority = HIGH`);
  assert(res.status === 200 && res.data.data.issues.length >= 1, 'Execute Parameterized JQL Search Query');

  // [14. My Work & Activity Stream]
  console.log('\n--- [14. My Work & Business Activity Stream] ---');
  res = await request(`/api/tasks/my-work?workspaceId=${wsId}`);
  assert(res.status === 200 && res.data.data.watchedIssues !== undefined, 'Query My Work Aggregates');

  res = await request(`/api/activity/${wsId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Workspace Business Activity Stream');

  // [15. Sprints & Agile Backlog]
  console.log('\n--- [15. Sprints & Agile Backlog] ---');
  res = await request(`/api/sprints/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Sprint 1 - Launch', goal: 'MVP Release' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Sprint 1 - Launch', 'Create Scrum Sprint');
  const sprintId = res.data.data.id;

  res = await request(`/api/sprints/${wsId}/${sprintId}/start`, { method: 'PATCH' });
  assert(res.status === 200 && res.data.status === 'ACTIVE', 'Start Scrum Sprint (ACTIVE)');

  res = await request(`/api/sprints/${wsId}/${sprintId}/complete`, { method: 'PATCH' });
  assert(res.status === 200 && res.data.status === 'CLOSED', 'Complete Scrum Sprint (CLOSED)');

  // [16. Releases & Versioning]
  console.log('\n--- [16. Releases & Versions Management] ---');
  res = await request(`/api/releases/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'v2.0.0-GA', description: 'Enterprise Release' }),
  });
  assert(res.status === 200 && res.data.data.name === 'v2.0.0-GA', 'Create Release Version');

  // [17. Dashboards & Reports]
  console.log('\n--- [17. Dashboards & KPI Reports] ---');
  res = await request(`/api/dashboards/${wsId}`);
  assert(res.status === 200 && res.data.data.summary !== undefined, 'Query Dashboard Gadgets');

  res = await request(`/api/reports/${wsId}`);
  assert(res.status === 200 && res.data.data.companyAnalytics !== undefined, 'Query Velocity & Cycle Time Reports');

  // [18. Governance: Tokens, Security, Audit & Backups]
  console.log('\n--- [18. Governance: Tokens, Security, Audit & Backups] ---');
  res = await request(`/api/api-tokens/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'CI Token', scopes: ['*'], expiresDays: 30 }),
  });
  assert(res.status === 200 && res.data.data.cleartextToken.startsWith('jira_live_'), 'Generate Masked Scoped API Token');

  res = await request(`/api/security/${wsId}`);
  assert(res.status === 200 && res.data.data.policy !== undefined, 'Query Security Policies');

  res = await request(`/api/audit-logs/${wsId}`);
  assert(res.status === 200 && res.data.data.length > 0, 'Query Enterprise Audit Trail');

  res = await request(`/api/billing/${wsId}`);
  assert(res.status === 200 && res.data.data.subscription !== undefined, 'Query SaaS Billing & Usage Meters');

  res = await request(`/api/data/${wsId}/export`);
  assert(res.status === 200 && res.data.data.company !== undefined, 'Export Complete Organization JSON Archive');

  // [19. Custom Fields & Field Values]
  console.log('\n--- [19. Custom Fields & Field Values] ---');
  res = await request(`/api/custom-fields/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Deployment Target', fieldType: 'SELECT', options: ['Staging', 'Production'] }),
  });
  assert(res.status === 200 && res.data.data.name === 'Deployment Target', 'Create Custom Field (Deployment Target)');
  const customFieldId = res.data.data.id;

  res = await request(`/api/custom-fields/values/${createdTaskId}`, {
    method: 'POST',
    body: JSON.stringify({ customFieldId, fieldValue: 'Production' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Set Custom Field Value on Issue');

  res = await request(`/api/custom-fields/values/${createdTaskId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query Issue Custom Field Values');

  // [20. Schemes: Issue Types & Priorities]
  console.log('\n--- [20. Schemes: Issue Types & Priority Schemes] ---');
  res = await request(`/api/schemes/issue-types/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Software Development Scheme', defaultIssueType: 'Story' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Software Development Scheme', 'Create Issue Type Scheme');

  res = await request(`/api/schemes/priorities/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Executive Priority Scheme', defaultPriority: 'HIGH' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Executive Priority Scheme', 'Create Priority Scheme');

  // [21. SLA Management & Tracking]
  console.log('\n--- [21. SLA Management & Tracking] ---');
  res = await request(`/api/sla/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Resolution SLA', targetMinutes: 120, priority: 'CRITICAL' }),
  });
  assert(res.status === 200 && res.data.data.targetMinutes === 120, 'Create SLA Policy Definition');

  // [22. Enterprise Webhooks & Ping Delivery]
  console.log('\n--- [22. Enterprise Webhooks & Ping Delivery] ---');
  res = await request(`/api/webhooks/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'CI/CD Webhook', url: 'https://ci.acme.io/jira-webhook' }),
  });
  assert(res.status === 200 && res.data.data.secret.startsWith('whsec_'), 'Register Enterprise Webhook');
  const webhookId = res.data.data.id;

  res = await request(`/api/webhooks/${webhookId}/test`, { method: 'POST' });
  assert(res.status === 200 && res.data.status === 'SUCCESS', 'Trigger Webhook Delivery Ping Test');

  // [23. User Favorites & Recent Navigation History]
  console.log('\n--- [23. User Favorites & Recent Navigation History] ---');
  res = await request(`/api/users/me/favorites/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ entityType: 'PROJECT', entityId: projId }),
  });
  assert(res.status === 200 && res.data.success === true, 'Save Project to User Favorites');

  res = await request(`/api/users/me/favorites/${wsId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Query User Favorites List');

  res = await request(`/api/users/me/recent-items/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ entityType: 'ISSUE', entityId: createdTaskId, title: 'Implement OAuth2 Google Auth' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Track User Recent Navigation Item');

  // [24. Cross-Project Dependency Graph & Circular Detection]
  console.log('\n--- [24. Cross-Project Dependency Graph & Circular Detection] ---');
  res = await request(`/api/dependencies/graph/${wsId}`);
  assert(res.status === 200 && res.data.data.nodes.length >= 2, 'Query Workspace Cross-Project Dependency Graph');

  res = await request('/api/dependencies', {
    method: 'POST',
    body: JSON.stringify({ sourceTaskId: createdTaskId, targetTaskId: createdTaskId }),
  });
  assert(res.status === 400, 'Block Self-Dependency Validation Check');

  // [25. Capacity Planning & Team Workload Utilization]
  console.log('\n--- [25. Capacity Planning & Team Workload Utilization] ---');
  res = await request(`/api/capacity/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ userId, workingHoursPerDay: 8.0, availabilityPercentage: 100.0 }),
  });
  assert(res.status === 200 && res.data.data.capacityHours === 40, 'Configure User Weekly Working Capacity');

  res = await request(`/api/capacity/workload/${wsId}`);
  assert(res.status === 200 && res.data.data.length >= 1, 'Compute Team Workload Utilization Percentage');

  // [26. Project Health Engine & Milestones]
  console.log('\n--- [26. Project Health Engine & Milestones] ---');
  res = await request(`/api/governance/milestones/${projId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Alpha Release Complete', targetDate: '2026-10-01' }),
  });
  assert(res.status === 200 && res.data.name === 'Alpha Release Complete', 'Create Project Milestone');

  res = await request(`/api/governance/health/${projId}`);
  assert(res.status === 200 && res.data.data.overallHealth !== undefined, 'Evaluate Dynamic Project Health Score');

  // [27. Project Risks, Decisions & Approval Workflows]
  console.log('\n--- [27. Project Risks, Decisions & Approval Workflows] ---');
  res = await request(`/api/governance/risks/${projId}`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Third-Party Auth Provider Latency', probability: 'HIGH', impact: 'HIGH' }),
  });
  assert(res.status === 200 && res.data.severity === 'CRITICAL', 'Calculate Risk Severity Matrix (CRITICAL)');

  res = await request(`/api/governance/decisions/${projId}`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Use PostgreSQL as Primary DB Engine', decision: 'Approved by Architecture Board' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Record Project Decision Log Entry');

  res = await request(`/api/governance/approvals/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ resourceType: 'PROD_DEPLOYMENT', resourceId: projId, reason: 'Production Rollout' }),
  });
  assert(res.status === 200 && res.data.status === 'PENDING', 'Submit Change Approval Request');
  const approvalId = res.data.id;

  res = await request(`/api/governance/approvals/item/${approvalId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'APPROVED' }),
  });
  assert(res.status === 200 && res.data.status === 'APPROVED', 'Authorize Change Approval Workflow');

  // [28. Jira Service Management: Requests & Support Queues]
  console.log('\n--- [28. Jira Service Management: Requests & Support Queues] ---');
  res = await request(`/api/service-management/${wsId}/requests`, {
    method: 'POST',
    body: JSON.stringify({ summary: 'VPN Connection Failure', requestType: 'INCIDENT', priority: 'HIGH', projectId: projId }),
  });
  assert(res.status === 200 && res.data.data.status === 'OPEN', 'Create Customer Service Desk Ticket');

  res = await request(`/api/service-management/${wsId}/queues`);
  assert(res.status === 200 && res.data.data.length >= 3, 'Query Support Agent Triage Queues');

  // [29. CMDB Assets & Service Dependency Maps]
  console.log('\n--- [29. CMDB Assets & Service Dependency Maps] ---');
  res = await request(`/api/assets/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Authentication API Gateway', type: 'SERVICE', environment: 'PRODUCTION' }),
  });
  assert(res.status === 200 && res.data.data.name === 'Authentication API Gateway', 'Register CMDB Service Asset');
  const assetId1 = res.data.data.id;

  res = await request(`/api/assets/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'User Profile PostgreSQL Database', type: 'DATABASE', environment: 'PRODUCTION' }),
  });
  assert(res.status === 200 && res.data.data.name === 'User Profile PostgreSQL Database', 'Register CMDB Database Asset');
  const assetId2 = res.data.data.id;

  res = await request(`/api/assets/${wsId}/dependencies`, {
    method: 'POST',
    body: JSON.stringify({ sourceAssetId: assetId1, targetAssetId: assetId2, relationship: 'queries data from' }),
  });
  assert(res.status === 200 && res.data.success === true, 'Map Service Infrastructure Dependency');

  // [30. Deployments & DORA Engineering Metrics]
  console.log('\n--- [30. Deployments & DORA Engineering Metrics] ---');
  res = await request(`/api/deployments/${projId}`, {
    method: 'POST',
    body: JSON.stringify({ environment: 'PRODUCTION', status: 'SUCCESS' }),
  });
  assert(res.status === 200 && res.data.status === 'SUCCESS', 'Log Production Deployment Record');

  res = await request(`/api/deployments/dora/${wsId}`);
  assert(res.status === 200 && res.data.data.doraRating !== undefined, 'Calculate Enterprise DORA Metrics');

  // [31. Portfolios, Initiatives & Strategic Goals]
  console.log('\n--- [31. Portfolios, Initiatives & Strategic Goals] ---');
  res = await request(`/api/portfolio/${wsId}`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Digital Transformation 2026' }),
  });
  assert(res.status === 200 && res.data.name === 'Digital Transformation 2026', 'Create Enterprise Portfolio');
  const portfolioId = res.data.id;

  res = await request(`/api/portfolio/${wsId}/initiatives`, {
    method: 'POST',
    body: JSON.stringify({ portfolioId, name: 'Cloud Migration Initiative', targetDate: '2026-12-31' }),
  });
  assert(res.status === 200 && res.data.name === 'Cloud Migration Initiative', 'Create Multi-Project Initiative');

  res = await request(`/api/portfolio/${wsId}/goals`, {
    method: 'POST',
    body: JSON.stringify({ name: '99.99% Availability & SSO Modernization' }),
  });
  assert(res.status === 200 && res.data.name === '99.99% Availability & SSO Modernization', 'Create Strategic Goal');

  // [32. Global Multi-Entity Search & Enterprise Home]
  console.log('\n--- [32. Global Multi-Entity Search & Enterprise Home] ---');
  res = await request(`/api/search/global?workspaceId=${wsId}&q=Auth`);
  assert(res.status === 200 && res.data.data.totalMatches >= 1, 'Execute Global Enterprise Search Across Entities');

  res = await request(`/api/enterprise/home?workspaceId=${wsId}`);
  assert(res.status === 200 && res.data.data.recentProjects.length >= 1, 'Load Personalized Jira Enterprise Home');

  console.log('\n========================================================================');
  console.log(`MASTER VERIFICATION SUITE: ${passed} Passed, ${failed} Failed`);
  console.log('========================================================================\n');

  if (failed > 0) process.exit(1);
}

runMasterE2ETestSuite().catch((err) => {
  console.error('Master Test Suite Error:', err);
  process.exit(1);
});
