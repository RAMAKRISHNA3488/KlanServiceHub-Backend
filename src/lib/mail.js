import 'dotenv/config';
import nodemailer from 'nodemailer';

export function getTransporter(env = {}) {
  const host = env.SMTP_HOST || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(env.SMTP_PORT || process.env.SMTP_PORT) || 465;
  const secure = env.SMTP_SECURE === 'true' || process.env.SMTP_SECURE === 'true' || port === 465;
  const user = env.SMTP_USER || process.env.SMTP_USER || 'navithajune06@gmail.com';
  const pass = env.SMTP_PASS || process.env.SMTP_PASS || 'epmoebutojwwicnf';

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user && pass ? { user, pass } : undefined,
    tls: {
      rejectUnauthorized: false, // Prevents self-signed or proxy TLS issues
    },
  });
}

export const transporter = getTransporter();

/**
 * Verify SMTP connection configuration
 */
export async function verifySmtpConnection() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[Mail] SMTP credentials not configured (SMTP_USER / SMTP_PASS missing).');
    return false;
  }
  try {
    const t = getTransporter();
    await t.verify();
    console.log('✅ [Mail] SMTP transporter verified successfully.');
    return true;
  } catch (error) {
    console.error('❌ [Mail] SMTP verification failed:', error.message);
    return false;
  }
}

/**
 * Send OTP Verification Email
 */
export async function sendOtpEmail({ to, otpCode, env = {} }) {
  if (!to || !otpCode) {
    throw new Error('Recipient email and OTP code are required.');
  }

  const user = env.SMTP_USER || process.env.SMTP_USER || 'navithajune06@gmail.com';
  const defaultFrom = env.SMTP_FROM || process.env.SMTP_FROM || `"klanservicehub" <${user}>`;
  const t = getTransporter(env);

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; margin: 0; padding: 20px; color: #172b4d; }
          .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #dfe1e6; overflow: hidden; }
          .header { background: #0052cc; padding: 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 24px; }
          .title { font-size: 18px; font-weight: 600; margin-top: 0; margin-bottom: 12px; }
          .code-box { background: #f4f5f7; border: 2px dashed #0052cc; border-radius: 8px; text-align: center; padding: 18px; margin: 24px 0; }
          .code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #0052cc; }
          .footer { padding: 16px 24px; background: #fafbfc; border-top: 1px solid #ebecf0; font-size: 12px; color: #6b778c; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>klanservicehub</h1>
          </div>
          <div class="content">
            <h2 class="title">Verify your email address</h2>
            <p>You recently requested a one-time verification code to sign in or register your account.</p>
            <div class="code-box">
              <span class="code">${otpCode}</span>
            </div>
            <p style="color: #6b778c; font-size: 14px;">This code is valid for <strong>10 minutes</strong>. If you did not request this verification code, please disregard this email.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} klanservicehub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const info = await t.sendMail({
      from: defaultFrom,
      to,
      subject: `Your klanservicehub Verification Code: ${otpCode}`,
      text: `Your klanservicehub verification code is: ${otpCode}. It is valid for 10 minutes.`,
      html,
    });
    console.log(`✉️ [Mail] Verification code sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [Mail] Failed to send OTP to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send Workspace / Project Invitation Email
 */
export async function sendInvitationEmail({
  to,
  inviterName = 'A team member',
  organizationName = 'Workspace',
  projectName,
  role = 'Member',
  inviteUrl,
  password,
  loginUrl,
  env = {},
}) {
  if (!to || !inviteUrl) {
    throw new Error('Recipient email and invite URL are required.');
  }

  const user = env.SMTP_USER || process.env.SMTP_USER || 'navithajune06@gmail.com';
  const defaultFrom = env.SMTP_FROM || process.env.SMTP_FROM || `"klanservicehub" <${user}>`;
  const t = getTransporter(env);

  const roleText = projectName ? `${role} in project "${projectName}"` : `${role} in "${organizationName}"`;
  const targetLoginUrl = loginUrl || inviteUrl;

  const credentialsHtml = password ? `
    <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 8px; padding: 18px 20px; margin: 24px 0; text-align: left;">
      <div style="font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 12px;">
        🔑 <strong>Your Account Login Credentials</strong>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 110px; font-weight: 600;">Email:</td>
          <td style="padding: 6px 0; color: #0f172a; font-family: monospace; font-size: 13px; font-weight: bold;">${to}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Password:</td>
          <td style="padding: 6px 0;">
            <span style="display: inline-block; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 4px; font-family: monospace; font-size: 14px; font-weight: bold; letter-spacing: 0.5px; border: 1px dashed #38bdf8;">
              ${password}
            </span>
          </td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b; font-weight: 600;">Login Portal:</td>
          <td style="padding: 6px 0;">
            <a href="${targetLoginUrl}" style="color: #0284c7; text-decoration: underline; font-weight: 600;">
              ${targetLoginUrl}
            </a>
          </td>
        </tr>
      </table>
      <div style="margin-top: 10px; font-size: 11px; color: #64748b; border-top: 1px solid #e2e8f0; pt-2;">
        🔒 You can log in directly using this password or click the button below to accept your invitation.
      </div>
    </div>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; margin: 0; padding: 20px; color: #172b4d; }
          .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #dfe1e6; overflow: hidden; }
          .header { background: #0052cc; padding: 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 24px; text-align: center; }
          .title { font-size: 20px; font-weight: 600; margin-top: 0; margin-bottom: 16px; color: #172b4d; }
          .cta-btn { display: inline-block; background-color: #0052cc; color: #ffffff !important; padding: 12px 28px; font-size: 15px; font-weight: 600; text-decoration: none; border-radius: 4px; margin: 16px 0; }
          .cta-btn:hover { background-color: #0747a6; }
          .footer { padding: 16px 24px; background: #fafbfc; border-top: 1px solid #ebecf0; font-size: 12px; color: #6b778c; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>klanservicehub</h1>
          </div>
          <div class="content">
            <h2 class="title">You've been invited to join ${organizationName}!</h2>
            <p><strong>${inviterName}</strong> has invited you to collaborate as a <strong>${roleText}</strong> on klanservicehub.</p>
            ${credentialsHtml}
            <a href="${inviteUrl}" class="cta-btn" target="_blank">Accept Invitation & Join</a>
            <p style="color: #6b778c; font-size: 13px; margin-top: 20px;">
              Or copy and paste this link into your browser:<br>
              <a href="${inviteUrl}" style="color: #0052cc; word-break: break-all;">${inviteUrl}</a>
            </p>
            <p style="color: #8993a4; font-size: 12px;">This invitation will expire in 7 days.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} klanservicehub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  const textContent = `${inviterName} invited you to join ${organizationName} on klanservicehub as ${roleText}.\n` +
    (password ? `\nYour Login Credentials:\nEmail: ${to}\nPassword: ${password}\nLogin URL: ${targetLoginUrl}\n` : '') +
    `\nAccept Invitation: ${inviteUrl}`;

  try {
    const info = await t.sendMail({
      from: defaultFrom,
      to,
      subject: `Invitation: Join ${organizationName} on klanservicehub`,
      text: textContent,
      html,
    });
    console.log(`✉️ [Mail] Invitation email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [Mail] Failed to send invitation email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Send Password Reset Email with Verification OTP and Direct Link
 */
export async function sendPasswordResetEmail({
  to,
  userName = 'there',
  otpCode,
  resetUrl,
  env = {},
}) {
  if (!to || !otpCode || !resetUrl) {
    throw new Error('Recipient email, OTP code, and reset URL are required.');
  }

  const user = env.SMTP_USER || process.env.SMTP_USER || 'navithajune06@gmail.com';
  const defaultFrom = env.SMTP_FROM || process.env.SMTP_FROM || `"klanservicehub" <${user}>`;
  const t = getTransporter(env);

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; margin: 0; padding: 20px; color: #172b4d; }
          .container { max-width: 540px; margin: 0 auto; background: #ffffff; border-radius: 8px; border: 1px solid #dfe1e6; overflow: hidden; }
          .header { background: #0052cc; padding: 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.5px; }
          .content { padding: 32px 24px; text-align: center; }
          .title { font-size: 20px; font-weight: 600; margin-top: 0; margin-bottom: 12px; color: #172b4d; }
          .sub { color: #5e6c84; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
          .code-box { background: #f4f5f7; border: 2px dashed #0052cc; border-radius: 8px; text-align: center; padding: 16px; margin: 20px auto; max-width: 320px; }
          .code-label { font-size: 11px; font-weight: 700; color: #5e6c84; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; }
          .code { font-family: 'Courier New', Courier, monospace; font-size: 34px; font-weight: bold; letter-spacing: 6px; color: #0052cc; }
          .cta-btn { display: inline-block; background-color: #0052cc; color: #ffffff !important; padding: 12px 28px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 4px; margin: 18px 0; }
          .cta-btn:hover { background-color: #0747a6; }
          .link-box { word-break: break-all; font-size: 12px; color: #0052cc; margin-top: 8px; }
          .footer { padding: 16px 24px; background: #fafbfc; border-top: 1px solid #ebecf0; font-size: 12px; color: #6b778c; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>klanservicehub</h1>
          </div>
          <div class="content">
            <h2 class="title">Reset Your Password</h2>
            <p class="sub">
              Hi ${userName},<br>
              We received a request to reset the password for your klanservicehub account. Use the verification code below or click the direct reset link.
            </p>

            <div class="code-box">
              <div class="code-label">Verification OTP Code</div>
              <div class="code">${otpCode}</div>
            </div>

            <p style="font-size: 13px; color: #5e6c84; margin: 16px 0 6px;">Or click the button to reset immediately:</p>
            <a href="${resetUrl}" class="cta-btn" target="_blank">Reset Password Now</a>

            <p style="color: #6b778c; font-size: 12px; margin-top: 20px;">
              Direct link:<br>
              <a href="${resetUrl}" class="link-box">${resetUrl}</a>
            </p>

            <p style="color: #8993a4; font-size: 11px; margin-top: 20px;">
              This code and link are valid for <strong>15 minutes</strong>. If you did not request a password reset, you can safely ignore this email.
            </p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} klanservicehub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  try {
    const info = await t.sendMail({
      from: defaultFrom,
      to,
      subject: `Reset your klanservicehub password: Code ${otpCode}`,
      text: `Your klanservicehub password reset code is: ${otpCode}. Reset link: ${resetUrl}. This link expires in 15 minutes.`,
      html,
    });
    console.log(`✉️ [Mail] Password reset email sent to ${to}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error(`❌ [Mail] Failed to send password reset email to ${to}:`, error.message);
    return { success: false, error: error.message };
  }
}
