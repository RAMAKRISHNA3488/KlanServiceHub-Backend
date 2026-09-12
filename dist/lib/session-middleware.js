import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { Account, Client, Databases, Storage, } from 'node-appwrite';
import { AUTH_COOKIE } from '@/features/auth/constants';
export const sessionMiddleware = createMiddleware(async (ctx, next) => {
    const client = new Client()
        .setEndpoint(process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT)
        .setProject(process.env.NEXT_PUBLIC_APPWRITE_PROJECT);
    const session = getCookie(ctx, AUTH_COOKIE);
    if (!session) {
        return ctx.json({ error: 'Unauthorized.' }, 401);
    }
    client.setSession(session);
    const account = new Account(client);
    const databases = new Databases(client);
    const storage = new Storage(client);
    const user = await account.get();
    ctx.set('account', account);
    ctx.set('databases', databases);
    ctx.set('storage', storage);
    ctx.set('user', user);
    await next();
});
