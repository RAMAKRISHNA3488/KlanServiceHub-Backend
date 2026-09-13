import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';

import { AUTH_COOKIE, SESSION_MAX_AGE_SECONDS, SESSION_MAX_AGE_MS } from '../constants.js';
import { signInFormSchema, signUpFormSchema } from '../schema.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, logAudit, ensureWorkspaceDefaults } from '../../../db.js';
import { sendOtpEmail, sendPasswordResetEmail } from '../../../lib/mail.js';
import { getFrontendUrl } from '../../../lib/config.js';

function setAuthCookie(ctx, sessionSecret) {
  const reqUrl = ctx.req.url || '';
  const isLocalhost = reqUrl.includes('localhost') || reqUrl.includes('127.0.0.1');
  const isProduction = !isLocalhost;

  setCookie(ctx, AUTH_COOKIE, sessionSecret, {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

const app = new Hono()
  .post(
    '/check-email',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
      }),
    ),
    async (ctx) => {
      const { email } = ctx.req.valid('json');
      const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email.toLowerCase().trim());
      if (user) {
        return ctx.json({ exists: true, email: user.email, name: user.name });
      }
      return ctx.json({ exists: false, email: email.toLowerCase().trim() });
    },
  )
  .post(
    '/send-otp',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        purpose: z.enum(['LOGIN', 'REGISTER', 'VERIFY']).optional(),
      }),
    ),
    async (ctx) => {
      const { email, purpose = 'LOGIN' } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      // If signing in with OTP, verify that the user already exists
      if (purpose === 'LOGIN') {
        const user = db.prepare('SELECT id, name, email, status FROM users WHERE email = ?').get(cleanEmail);
        if (!user) {
          return ctx.json({ error: 'User does not exist. Please check your email or register a new account.' }, 404);
        }
        if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
          return ctx.json({ error: 'Your account has been deactivated. Please contact support.' }, 403);
        }
      }

      // Generate secure 6-digit OTP
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpHash = bcrypt.hashSync(otpCode, 10);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

      // Invalidate old OTPs for this email
      db.prepare('DELETE FROM email_verifications WHERE email = ?').run(cleanEmail);

      const verificationId = randomUUID();
      db.prepare(`
        INSERT INTO email_verifications (id, email, otp_hash, expires_at, attempt_count, verified)
        VALUES (?, ?, ?, ?, 0, 0)
      `).run(verificationId, cleanEmail, otpHash, expiresAt);

      console.log(`[KLANSERVICEHUB OTP] Verification code for ${cleanEmail}: ${otpCode}`);

      // Dispatch real email via configured SMTP
      const mailResult = await sendOtpEmail({ to: cleanEmail, otpCode });

      return ctx.json({
        success: true,
        message: mailResult.success
          ? `Verification code sent to ${cleanEmail}`
          : `Verification code generated for ${cleanEmail}`,
        emailSent: mailResult.success,
      });
    },
  )
  .post(
    '/login-with-otp',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        otp: z.string().min(6).max(6),
      }),
    ),
    async (ctx) => {
      const { email, otp } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      if (!user) {
        return ctx.json({ error: 'User does not exist. Please check your email or register a new account.' }, 404);
      }

      if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
        return ctx.json({ error: 'Your account has been deactivated. Please contact support.' }, 403);
      }

      const verification = db.prepare(`
        SELECT * FROM email_verifications 
        WHERE email = ? AND datetime(expires_at) > datetime('now') AND verified = 0
      `).get(cleanEmail);

      if (!verification) {
        return ctx.json({ error: 'Verification code has expired or is invalid. Please request a new code.' }, 400);
      }

      if (verification.attempt_count >= 5) {
        db.prepare('DELETE FROM email_verifications WHERE id = ?').run(verification.id);
        return ctx.json({ error: 'Too many failed attempts. Please request a new code.' }, 400);
      }

      const isValid = bcrypt.compareSync(otp, verification.otp_hash);
      if (!isValid) {
        db.prepare('UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?').run(verification.id);
        return ctx.json({ error: 'Invalid verification code. Please try again.' }, 400);
      }

      // Invalidate used verification code
      db.prepare('UPDATE email_verifications SET verified = 1 WHERE id = ?').run(verification.id);

      // Check if user has active workspace
      let ws = db.prepare(`
        SELECT w.id FROM workspaces w 
        JOIN members m ON w.id = m.workspace_id 
        WHERE m.user_id = ? AND m.status = 'ACTIVE'
        LIMIT 1
      `).get(user.id);

      if (!ws) {
        const wsId = randomUUID();
        const wsName = `${(user.name || 'My').split(' ')[0]}'s Workspace`;
        const inviteCode = randomUUID().slice(0, 6).toUpperCase();
        db.prepare('INSERT INTO workspaces (id, name, user_id, invite_code) VALUES (?, ?, ?, ?)').run(wsId, wsName, user.id, inviteCode);
        db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(randomUUID(), wsId, user.id);
        ensureWorkspaceDefaults(wsId, user.id);
        ws = { id: wsId };
      }

      const sessionSecret = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, secret, expires_at) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), user.id, sessionSecret, expiresAt);

      setAuthCookie(ctx, sessionSecret);

      return ctx.json({
        success: true,
        token: sessionSecret,
        sessionSecret,
        user: formatDoc(user),
        workspaceId: ws.id,
      });
    },
  )
  .post(
    '/verify-otp',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        otp: z.string().min(6).max(6),
      }),
    ),
    async (ctx) => {
      const { email, otp } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const verification = db.prepare(`
        SELECT * FROM email_verifications 
        WHERE email = ? AND datetime(expires_at) > datetime('now') AND verified = 0
      `).get(cleanEmail);

      if (!verification) {
        return ctx.json({ error: 'Verification code has expired or is invalid. Please request a new code.' }, 400);
      }

      if (verification.attempt_count >= 5) {
        db.prepare('DELETE FROM email_verifications WHERE id = ?').run(verification.id);
        return ctx.json({ error: 'Too many failed attempts. Please request a new code.' }, 400);
      }

      const isValid = bcrypt.compareSync(otp, verification.otp_hash);
      if (!isValid) {
        db.prepare('UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?').run(verification.id);
        return ctx.json({ error: 'Invalid verification code. Please try again.' }, 400);
      }

      // Mark verified
      db.prepare('UPDATE email_verifications SET verified = 1 WHERE id = ?').run(verification.id);

      return ctx.json({ success: true, verified: true });
    },
  )
  .post('/send-verification', async (ctx) => {
    const body = await ctx.req.json();
    const cleanEmail = (body.email || '').toLowerCase().trim();
    if (!cleanEmail) return ctx.json({ error: 'Email is required.' }, 400);

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = bcrypt.hashSync(otpCode, 8);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    db.prepare('DELETE FROM email_verifications WHERE email = ?').run(cleanEmail);
    db.prepare(`
      INSERT INTO email_verifications (id, email, otp_hash, expires_at, attempt_count, verified)
      VALUES (?, ?, ?, ?, 0, 0)
    `).run(randomUUID(), cleanEmail, otpHash, expiresAt);

    return ctx.json({ success: true, message: `Verification code sent to ${cleanEmail}` });
  })
  .post('/verify-email', async (ctx) => {
    const { email, code, otp } = await ctx.req.json();
    const cleanEmail = (email || '').toLowerCase().trim();
    const codeToVerify = otp || code;

    const verification = db.prepare(`
      SELECT * FROM email_verifications 
      WHERE email = ? AND datetime(expires_at) > datetime('now') AND verified = 0
    `).get(cleanEmail);

    if (!verification) {
      return ctx.json({ error: 'Verification code has expired or is invalid.' }, 400);
    }

    const isValid = bcrypt.compareSync(codeToVerify, verification.otp_hash);
    if (!isValid) {
      db.prepare('UPDATE email_verifications SET attempt_count = attempt_count + 1 WHERE id = ?').run(verification.id);
      return ctx.json({ error: 'Invalid verification code.' }, 400);
    }

    db.prepare('UPDATE email_verifications SET verified = 1 WHERE id = ?').run(verification.id);
    return ctx.json({ success: true, verified: true });
  })
  .post('/register', zValidator('json', signUpFormSchema), async (ctx) => {
    try {
      const { name, email, password } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
      if (existingUser) {
        return ctx.json({ error: 'A user with this email already exists.' }, 400);
      }

      const userId = randomUUID();
      const passwordHash = bcrypt.hashSync(password, 10);

      db.prepare(`
        INSERT INTO users (id, name, email, password_hash, onboarding_status, status) 
        VALUES (?, ?, ?, ?, 'COMPLETED', 'ACTIVE')
      `).run(userId, name, cleanEmail, passwordHash);

      // Automatically create a default workspace with defaults for immediate productivity
      const wsId = randomUUID();
      const wsName = `${name.split(' ')[0]}'s Workspace`;
      const inviteCode = randomUUID().slice(0, 6).toUpperCase();
      db.prepare('INSERT INTO workspaces (id, name, user_id, invite_code) VALUES (?, ?, ?, ?)').run(wsId, wsName, userId, inviteCode);
      db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(randomUUID(), wsId, userId);
      ensureWorkspaceDefaults(wsId, userId);

      const sessionSecret = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, secret, expires_at) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), userId, sessionSecret, expiresAt);

      setAuthCookie(ctx, sessionSecret);

      return ctx.json({
        success: true,
        token: sessionSecret,
        sessionSecret,
        user: { id: userId, name, email: cleanEmail, onboardingStatus: 'COMPLETED' },
        workspaceId: wsId,
      });
    } catch (error) {
      console.error('[AUTH_REGISTER_ERROR]:', error);
      return ctx.json({ error: error.message || 'Failed to register account' }, 400);
    }
  })
  .post('/login', zValidator('json', signInFormSchema), async (ctx) => {
    try {
      const { email, password } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return ctx.json({ error: 'Invalid email or password.' }, 400);
      }

      if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
        return ctx.json({ error: 'Your account has been deactivated. Please contact support or your organization owner.' }, 403);
      }

      // Check if user has any workspace, if not auto-provision one
      let ws = db.prepare(`
        SELECT w.id FROM workspaces w 
        JOIN members m ON w.id = m.workspace_id 
        WHERE m.user_id = ? AND m.status = 'ACTIVE'
        LIMIT 1
      `).get(user.id);

      if (!ws) {
        const wsId = randomUUID();
        const wsName = `${(user.name || 'My').split(' ')[0]}'s Workspace`;
        const inviteCode = randomUUID().slice(0, 6).toUpperCase();
        db.prepare('INSERT INTO workspaces (id, name, user_id, invite_code) VALUES (?, ?, ?, ?)').run(wsId, wsName, user.id, inviteCode);
        db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(randomUUID(), wsId, user.id);
        ensureWorkspaceDefaults(wsId, user.id);
        ws = { id: wsId };
      }

      const sessionSecret = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, secret, expires_at) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), user.id, sessionSecret, expiresAt);

      setAuthCookie(ctx, sessionSecret);

      return ctx.json({ 
        success: true, 
        token: sessionSecret,
        sessionSecret,
        user: formatDoc(user),
        workspaceId: ws.id,
      });
    } catch (error) {
      console.error('[AUTH_LOGIN_ERROR]:', error);
      return ctx.json({ error: error.message || 'Failed to login' }, 400);
    }
  })
  .post(
    '/social-login',
    zValidator(
      'json',
      z.object({
        provider: z.enum(['google', 'microsoft', 'github', 'apple']),
        email: z.string().email(),
        name: z.string().optional(),
        avatarUrl: z.string().optional(),
      }),
    ),
    async (ctx) => {
      try {
        const { provider, email, name, avatarUrl } = ctx.req.valid('json');
        const cleanEmail = email.toLowerCase().trim();
        const userName = name || cleanEmail.split('@')[0] || 'Team User';

        let user = db.prepare('SELECT * FROM users WHERE email = ?').get(cleanEmail);

        if (!user) {
          // Auto-provision user with OAuth Provider
          const userId = randomUUID();
          const dummyHash = bcrypt.hashSync(randomUUID(), 10);
          db.prepare(`
            INSERT INTO users (id, name, email, password_hash, onboarding_status, status, image_url)
            VALUES (?, ?, ?, ?, 'COMPLETED', 'ACTIVE', ?)
          `).run(userId, userName, cleanEmail, dummyHash, avatarUrl || null);

          // Auto-create workspace
          const wsId = randomUUID();
          const wsName = `${userName.split(' ')[0]}'s Workspace`;
          const inviteCode = randomUUID().slice(0, 6).toUpperCase();
          db.prepare('INSERT INTO workspaces (id, name, user_id, invite_code) VALUES (?, ?, ?, ?)').run(wsId, wsName, userId, inviteCode);
          db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(randomUUID(), wsId, userId);
          ensureWorkspaceDefaults(wsId, userId);

          user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
        }

        if (user.status === 'SUSPENDED' || user.status === 'DEACTIVATED') {
          return ctx.json({ error: 'Your account has been deactivated. Please contact support.' }, 403);
        }

        // Check if user has active workspace
        let ws = db.prepare(`
          SELECT w.id FROM workspaces w 
          JOIN members m ON w.id = m.workspace_id 
          WHERE m.user_id = ? AND m.status = 'ACTIVE'
          LIMIT 1
        `).get(user.id);

        if (!ws) {
          const wsId = randomUUID();
          const wsName = `${(user.name || 'My').split(' ')[0]}'s Workspace`;
          const inviteCode = randomUUID().slice(0, 6).toUpperCase();
          db.prepare('INSERT INTO workspaces (id, name, user_id, invite_code) VALUES (?, ?, ?, ?)').run(wsId, wsName, user.id, inviteCode);
          db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(randomUUID(), wsId, user.id);
          ensureWorkspaceDefaults(wsId, user.id);
          ws = { id: wsId };
        }

        const sessionSecret = randomUUID();
        const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

        db.prepare(`
          INSERT INTO sessions (id, user_id, secret, expires_at) VALUES (?, ?, ?, ?)
        `).run(randomUUID(), user.id, sessionSecret, expiresAt);

        setAuthCookie(ctx, sessionSecret);

        return ctx.json({
          success: true,
          token: sessionSecret,
          sessionSecret,
          user: formatDoc(user),
          workspaceId: ws.id,
          provider,
        });
      } catch (err) {
        console.error('[SOCIAL_LOGIN_ERROR]:', err);
        return ctx.json({ error: err.message || 'Social login failed' }, 400);
      }
    },
  )
  .post(
    '/forgot-password',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
      }),
    ),
    async (ctx) => {
      const { email } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(cleanEmail);
      if (!user) {
        return ctx.json({ error: 'No account found with this email address.' }, 404);
      }

      // Generate 6-digit verification code & reset token
      const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
      const otpHash = bcrypt.hashSync(otpCode, 10);
      const token = randomBytes(24).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

      // Invalidate old password resets for this user
      db.prepare('DELETE FROM password_resets WHERE email = ?').run(cleanEmail);

      const resetId = randomUUID();
      db.prepare(`
        INSERT INTO password_resets (id, user_id, email, otp_hash, token, expires_at, attempt_count, used)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0)
      `).run(resetId, user.id, cleanEmail, otpHash, token, expiresAt);

      console.log(`[KLANSERVICEHUB RESET OTP] Password reset code for ${cleanEmail}: ${otpCode}`);

      const frontendUrl = getFrontendUrl(ctx);
      const resetUrl = `${frontendUrl}/reset-password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;

      const mailResult = await sendPasswordResetEmail({
        to: cleanEmail,
        userName: user.name,
        otpCode,
        resetUrl,
      });

      return ctx.json({
        success: true,
        message: mailResult.success
          ? `Password reset code and link sent to ${cleanEmail}`
          : `Password reset request registered for ${cleanEmail}`,
        emailSent: mailResult.success,
        token,
        resetUrl,
      });
    },
  )
  .post(
    '/verify-reset-otp',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        otp: z.string().min(6).max(6),
      }),
    ),
    async (ctx) => {
      const { email, otp } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      const reset = db.prepare(`
        SELECT * FROM password_resets 
        WHERE email = ? AND used = 0 AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `).get(cleanEmail);

      if (!reset) {
        return ctx.json({ error: 'Reset code has expired or is invalid. Please request a new code.' }, 400);
      }

      if (reset.attempt_count >= 5) {
        db.prepare('DELETE FROM password_resets WHERE id = ?').run(reset.id);
        return ctx.json({ error: 'Too many failed attempts. Please request a new code.' }, 400);
      }

      const isValid = bcrypt.compareSync(otp, reset.otp_hash);
      if (!isValid) {
        db.prepare('UPDATE password_resets SET attempt_count = attempt_count + 1 WHERE id = ?').run(reset.id);
        return ctx.json({ error: 'Invalid verification code. Please check and try again.' }, 400);
      }

      return ctx.json({ success: true, verified: true, token: reset.token });
    },
  )
  .post(
    '/reset-password',
    zValidator(
      'json',
      z.object({
        email: z.string().email(),
        password: z.string().min(8, 'Password must be at least 8 characters long'),
        otp: z.string().optional(),
        token: z.string().optional(),
      }),
    ),
    async (ctx) => {
      const { email, password, otp, token } = ctx.req.valid('json');
      const cleanEmail = email.toLowerCase().trim();

      if (!otp && !token) {
        return ctx.json({ error: 'Verification code or reset token is required.' }, 400);
      }

      const reset = db.prepare(`
        SELECT * FROM password_resets 
        WHERE email = ? AND used = 0 AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC LIMIT 1
      `).get(cleanEmail);

      if (!reset) {
        return ctx.json({ error: 'Password reset request has expired or is invalid. Please request a new code.' }, 400);
      }

      let isAuthorized = false;

      if (token && reset.token === token) {
        isAuthorized = true;
      } else if (otp && bcrypt.compareSync(otp, reset.otp_hash)) {
        isAuthorized = true;
      }

      if (!isAuthorized) {
        return ctx.json({ error: 'Invalid verification code or token. Please try again.' }, 400);
      }

      // Hash and update password
      const newPasswordHash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newPasswordHash, reset.user_id);

      // Invalidate the reset record
      db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(reset.id);

      // Clear any older sessions for security
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(reset.user_id);

      // Create a fresh session and log user in immediately
      const sessionSecret = randomUUID();
      const sessionExpires = new Date(Date.now() + SESSION_MAX_AGE_MS).toISOString();

      db.prepare(`
        INSERT INTO sessions (id, user_id, secret, expires_at) VALUES (?, ?, ?, ?)
      `).run(randomUUID(), reset.user_id, sessionSecret, sessionExpires);

      setAuthCookie(ctx, sessionSecret);

      // Find user's workspace
      const ws = db.prepare(`
        SELECT w.id FROM workspaces w 
        JOIN members m ON w.id = m.workspace_id 
        WHERE m.user_id = ? AND m.status = 'ACTIVE'
        LIMIT 1
      `).get(reset.user_id);

      return ctx.json({
        success: true,
        message: 'Password reset successfully!',
        token: sessionSecret,
        sessionSecret,
        workspaceId: ws?.id,
      });
    },
  )
  .get('/current', sessionMiddleware, (ctx) => {
    const user = ctx.get('user');
    const fullUser = db.prepare('SELECT * FROM users WHERE id = ?').get(user.$id);

    // Fetch all organizations/workspaces this user belongs to
    const workspaces = db.prepare(`
      SELECT w.id, w.name, w.domain_slug, w.image_url, m.role, m.organization_role, m.status, w.user_id = ? as is_owner
      FROM members m
      JOIN workspaces w ON m.workspace_id = w.id
      WHERE m.user_id = ? AND m.status = 'ACTIVE'
    `).all(user.$id, user.$id);

    return ctx.json({
      data: {
        ...formatDoc(fullUser),
        workspaces,
      },
    });
  })
  .post('/logout', sessionMiddleware, async (ctx) => {
    const sessionSecret = getCookie(ctx, AUTH_COOKIE);
    if (sessionSecret) {
      db.prepare('DELETE FROM sessions WHERE secret = ?').run(sessionSecret);
    }

    deleteCookie(ctx, AUTH_COOKIE);
    return ctx.json({ success: true });
  });

export default app;
