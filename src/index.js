import { Hono } from 'hono';
import { cors } from 'hono/cors';
import 'dotenv/config';

import auth from './features/auth/server/route.js';
import members from './features/members/server/route.js';
import projects from './features/projects/server/route.js';
import tasks from './features/tasks/server/route.js';
import workspaces from './features/workspaces/server/route.js';

// Enterprise Jira Modules
import company from './features/company/server/route.js';
import users from './features/users/server/route.js';
import roles from './features/roles/server/route.js';
import teams from './features/teams/server/route.js';
import workflows from './features/workflows/server/route.js';
import issueTypes from './features/issue-types/server/route.js';
import sprints from './features/sprints/server/route.js';
import boards from './features/boards/server/route.js';
import dashboards from './features/dashboards/server/route.js';
import reports from './features/reports/server/route.js';
import automations from './features/automations/server/route.js';
import notifications from './features/notifications/server/route.js';
import integrations from './features/integrations/server/route.js';
import apiTokens from './features/api-tokens/server/route.js';
import security from './features/security/server/route.js';
import auditLogs from './features/audit-logs/server/route.js';
import billing from './features/billing/server/route.js';
import data from './features/data/server/route.js';
import releases from './features/releases/server/route.js';
import invitations from './features/invitations/server/route.js';
import groups from './features/groups/server/route.js';
import components from './features/components/server/route.js';
import worklogs from './features/worklogs/server/route.js';
import filters from './features/filters/server/route.js';
import activity from './features/activity/server/route.js';
import customFields from './features/custom-fields/server/route.js';
import schemes from './features/schemes/server/route.js';
import sla from './features/sla/server/route.js';
import webhooks from './features/webhooks/server/route.js';
import favorites from './features/favorites/server/route.js';
import dependencies from './features/dependencies/server/route.js';
import capacity from './features/capacity/server/route.js';
import governance from './features/governance/server/route.js';
import serviceManagement from './features/service-management/server/route.js';
import assets from './features/assets/server/route.js';
import deployments from './features/deployments/server/route.js';
import portfolio from './features/portfolio/server/route.js';
import search from './features/search/server/route.js';
import { cacheMiddleware, autoInvalidateCacheMiddleware, cacheStore } from './lib/cache.js';
import { getFrontendUrl } from './lib/config.js';
import { initOrSyncD1 } from './db.js';

const app = new Hono();

// Cloudflare D1 Database synchronization and hydration middleware
app.use('*', async (c, next) => {
  if (c.env && c.env.DB) {
    try {
      await initOrSyncD1(c.env.DB, c.executionCtx);
    } catch (err) {
      console.error('[D1_MIDDLEWARE_SYNC_ERROR]:', err);
    }
  }
  return next();
});

app.use('*', async (c, next) => {
  const allowedOrigin = getFrontendUrl(c);
  return cors({
    origin: (origin) => {
      if (!origin) return allowedOrigin;
      if (
        origin === allowedOrigin ||
        origin.startsWith('http://localhost:') ||
        origin.startsWith('http://127.0.0.1:') ||
        origin.endsWith('.pages.dev') ||
        origin.endsWith('.workers.dev') ||
        origin.includes('klanservicehub') ||
        origin.includes('jira')
      ) {
        return origin;
      }
      return allowedOrigin;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'authorization',
      'Cookie',
      'cookie',
      'If-None-Match',
      'x-session-token',
      'X-Session-Token',
      'x-auth-token',
      'X-Auth-Token',
      'x-workspace-id',
      'X-Workspace-Id',
      'x-requested-with',
      'X-Requested-With',
      'Accept',
      'Origin',
    ],
    exposeHeaders: ['Set-Cookie', 'ETag', 'X-Cache-Status'],
    maxAge: 86400,
  })(c, next);
});

// Explicit OPTIONS preflight handler
app.options('*', (c) => {
  return c.text('', 204);
});

// Auto-invalidate cache tags on mutating HTTP requests (POST, PUT, PATCH, DELETE)
app.use('*', autoInvalidateCacheMiddleware());

// In-memory query cache & ETag conditional validation (304 Not Modified) for API routes
app.use('/api/*', cacheMiddleware({ ttlSeconds: 30 }));

app.get('/health', (ctx) => {
  return ctx.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Cache management & telemetry endpoints
app.get('/api/cache/stats', (ctx) => {
  return ctx.json({ status: 'ok', ...cacheStore.getStats() });
});

app.post('/api/cache/purge', (ctx) => {
  cacheStore.clear();
  return ctx.json({ success: true, message: 'Cache purged successfully' });
});

const api = new Hono().basePath('/api');

api
  .route('/auth', auth)
  .route('/members', members)
  .route('/projects', projects)
  .route('/tasks', tasks)
  .route('/workspaces', workspaces)
  .route('/company', company)
  .route('/users', users)
  .route('/roles', roles)
  .route('/teams', teams)
  .route('/workflows', workflows)
  .route('/issue-types', issueTypes)
  .route('/sprints', sprints)
  .route('/boards', boards)
  .route('/dashboards', dashboards)
  .route('/reports', reports)
  .route('/analytics', reports)
  .route('/organizations/:workspaceId/analytics', reports)
  .route('/automations', automations)
  .route('/notifications', notifications)
  .route('/integrations', integrations)
  .route('/api-tokens', apiTokens)
  .route('/security', security)
  .route('/audit-logs', auditLogs)
  .route('/billing', billing)
  .route('/data', data)
  .route('/releases', releases)
  .route('/invitations', invitations)
  .route('/groups', groups)
  .route('/components', components)
  .route('/worklogs', worklogs)
  .route('/filters', filters)
  .route('/activity', activity)
  .route('/custom-fields', customFields)
  .route('/schemes', schemes)
  .route('/sla', sla)
  .route('/webhooks', webhooks)
  .route('/users/me', favorites)
  .route('/dependencies', dependencies)
  .route('/capacity', capacity)
  .route('/governance', governance)
  .route('/service-management', serviceManagement)
  .route('/assets', assets)
  .route('/deployments', deployments)
  .route('/portfolio', portfolio)
  .route('/search', search)
  .route('/enterprise', search);

const apiV1 = new Hono().basePath('/api/v1');
apiV1
  .route('/auth', auth)
  .route('/organizations', company)
  .route('/projects', projects)
  .route('/tasks', tasks)
  .route('/members', members)
  .route('/invitations', invitations)
  .route('/groups', groups)
  .route('/roles', roles)
  .route('/sprints', sprints)
  .route('/reports', reports)
  .route('/analytics', reports)
  .route('/releases', releases)
  .route('/components', components)
  .route('/worklogs', worklogs)
  .route('/filters', filters)
  .route('/activity', activity)
  .route('/custom-fields', customFields)
  .route('/schemes', schemes)
  .route('/sla', sla)
  .route('/webhooks', webhooks)
  .route('/users/me', favorites)
  .route('/dependencies', dependencies)
  .route('/capacity', capacity)
  .route('/governance', governance)
  .route('/service-management', serviceManagement)
  .route('/assets', assets)
  .route('/deployments', deployments)
  .route('/portfolio', portfolio)
  .route('/search', search)
  .route('/enterprise', search);

app.route('/api', api);
app.route('/api/v1', apiV1);
app.route('/api/auth', auth);
app.route('/', api);

import { formatErrorResponse } from './lib/errors.js';

// Global 404 Route Handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: `Route not found: ${c.req.method} ${c.req.path}`,
    code: 'NOT_FOUND',
    statusCode: 404,
    path: c.req.path,
    method: c.req.method,
    timestamp: new Date().toISOString(),
  }, 404);
});

// Centralized Enterprise Exception Handler
app.onError((err, c) => {
  console.error(`[API_EXCEPTION] ${c.req.method} ${c.req.path} ->`, err.message || err);
  const errorPayload = formatErrorResponse(err, c.req);
  return c.json(errorPayload, errorPayload.statusCode);
});

import { backfillProjectAndTaskKeys } from './lib/issue-key.js';

// Ensure all projects and tasks have unique, project-wise keys
try {
  backfillProjectAndTaskKeys();
} catch (e) {
  // Ignore in serverless isolate
}

const port = Number(process.env.PORT) || 5000;
const isDirectRun = typeof process !== 'undefined' && process.argv && process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('src/index.js') || process.argv[1].endsWith('src\\index.js'));

if (isDirectRun && process.env.TEST_MODE !== 'true') {
  console.log(`🚀 Backend server is running on http://localhost:${port}`);
  import('@hono/node-server').then(({ serve }) => {
    serve({
      fetch: app.fetch,
      port,
    });
  }).catch((err) => {
    console.error('[SERVER_START_ERROR]:', err);
  });
}

export default app;
