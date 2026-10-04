import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import 'dotenv/config';
import auth from '@/features/auth/server/route';
import members from '@/features/members/server/route';
import projects from '@/features/projects/server/route';
import tasks from '@/features/tasks/server/route';
import workspaces from '@/features/workspaces/server/route';
const app = new Hono();
const allowedOrigin = process.env.FRONTEND_URL || 'http://localhost:3000';
app.use('/api/*', cors({
    origin: (origin) => {
        if (!origin || origin === allowedOrigin || origin.startsWith('http://localhost:')) {
            return origin || allowedOrigin;
        }
        return allowedOrigin;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    exposeHeaders: ['Set-Cookie'],
}));
app.get('/health', (ctx) => {
    return ctx.json({ status: 'ok', timestamp: new Date().toISOString() });
});
const api = new Hono().basePath('/api');
const routes = api
    .route('/auth', auth)
    .route('/members', members)
    .route('/projects', projects)
    .route('/tasks', tasks)
    .route('/workspaces', workspaces);
app.route('/', api);
const port = Number(process.env.PORT) || 5000;
console.log(`🚀 Backend server is running on http://localhost:${port}`);
serve({
    fetch: app.fetch,
    port,
});
export default app;
