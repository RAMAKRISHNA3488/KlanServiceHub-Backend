import 'dotenv/config';
import nodemailer from 'nodemailer';

/**
 * Universal email dispatcher supporting:
 * 1. Cloudflare Workers compatible HTTPS REST APIs (Resend, Brevo, SendGrid)
 * 2. Standard SMTP / Gmail App Password via Nodemailer in Node environments
 */
async function dispatchEmail({ to, subject, text, html }) {
  const fromEmail = process.env.SMTP_FROM || `"KlanServiceHub" <${process.env.SMTP_USER || 'notifications@klanservicehub.dev'}>`;

  // 1. Resend REST API (Cloudflare Workers Native)
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [to],
          subject,
          text,
          html,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✉️ [Mail/Resend] Sent successfully to ${to} (id: ${data.id})`);
        return { success: true, messageId: data.id };
      }
      console.warn(`[Mail/Resend] Error:`, data);
    } catch (e) {
      console.error(`[Mail/Resend] Exception:`, e.message);
    }
  }

  // 2. Brevo (Sendinblue) REST API (Cloudflare Workers Native)
  if (process.env.BREVO_API_KEY) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'KlanServiceHub', email: process.env.SMTP_USER || 'no-reply@klanservicehub.com' },
          to: [{ email: to }],
          subject,
          textContent: text,
          htmlContent: html,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`✉️ [Mail/Brevo] Sent successfully to ${to}`);
        return { success: true, messageId: data.messageId || 'brevo-ok' };
      }
      console.warn(`[Mail/Brevo] Error:`, data);
    } catch (e) {
      console.error(`[Mail/Brevo] Exception:`, e.message);
    }
  }

  // 3. SendGrid REST API (Cloudflare Workers Native)
  if (process.env.SENDGRID_API_KEY) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: process.env.SMTP_USER || 'notifications@klanservicehub.dev', name: 'KlanServiceHub' },
          subject,
          content: [
            { type: 'text/plain', value: text || '' },
            { type: 'text/html', value: html || '' },
          ],
        }),
      });
      if (res.ok || res.status === 202) {
        console.log(`✉️ [Mail/SendGrid] Sent successfully to ${to}`);
        return { success: true };
      }
    } catch (e) {
      console.error(`[Mail/SendGrid] Exception:`, e.message);
    }
  }

  // 4. Standard SMTP / Gmail via Nodemailer
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (user && pass) {
    try {
      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
        tls: { rejectUnauthorized: false },
      });

      const info = await transporter.sendMail({
        from: fromEmail,
        to,
        subject,
        text,
        html,
      });

      console.log(`✉️ [Mail/SMTP] Delivered to ${to}: ${info.messageId}`);
      return { success: true, messageId: info.messageId };
    } catch (smtpErr) {
      console.error(`❌ [Mail/SMTP] Delivery error to ${to}:`, smtpErr.message);
      return { success: false, error: smtpErr.message };
    }
  }

  console.warn(`[Mail] No active email delivery credentials configured.`);
  return { success: false, error: 'Email service credentials not configured.' };
}

/**
 * Verify SMTP connection configuration
 */
export async function verifySmtpConnection() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    console.warn('[Mail] SMTP credentials not configured.');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT) || 587,
      auth: { user, pass },
    });
    await transporter.verify();
    console.log('✅ [Mail] SMTP transporter verified successfully.');
    return true;
  } catch (error) {
    console.error('❌ [Mail] SMTP verification check:', error.message);
    return false;
  }
}

/**
 * Send OTP Verification Email
 */
export async function sendOtpEmail({ to, otpCode }) {
  if (!to || !otpCode) {
    throw new Error('Recipient email and OTP code are required.');
  }

  const subject = `Your KlanServiceHub Verification Code: ${otpCode}`;
  const text = `Your KlanServiceHub verification code is: ${otpCode}. It is valid for 10 minutes.`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; margin: 0; padding: 24px; color: #f1f5f9; }
          .container { max-width: 520px; margin: 0 auto; background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          .header { background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%); padding: 28px 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
          .content { padding: 32px 28px; text-align: center; }
          .title { font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 12px; color: #ffffff; }
          .desc { font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px; }
          .code-box { background: #0f172a; border: 2px dashed #3b82f6; border-radius: 12px; text-align: center; padding: 20px; margin: 24px auto; max-width: 300px; }
          .code { font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 800; letter-spacing: 10px; color: #60a5fa; }
          .footer { padding: 20px 24px; background: #0f172a; border-top: 1px solid #334155; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>KlanServiceHub</h1>
          </div>
          <div class="content">
            <h2 class="title">Verify Your Email Address</h2>
            <p class="desc">You requested a one-time verification code to securely access your KlanServiceHub account.</p>
            <div class="code-box">
              <span class="code">${otpCode}</span>
            </div>
            <p style="color: #64748b; font-size: 13px; margin-top: 24px;">This code is valid for <strong>10 minutes</strong>. If you did not request this code, you can safely ignore this message.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} KlanServiceHub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  return await dispatchEmail({ to, subject, text, html });
}

/**
 * Send Workspace / Project Invitation Email
 */
export async function sendInvitationEmail({
  to,
  inviterName = 'A team administrator',
  organizationName = 'Workspace',
  projectName,
  role = 'Member',
  inviteUrl,
  password,
}) {
  if (!to || !inviteUrl) {
    throw new Error('Recipient email and invite URL are required.');
  }

  const roleText = projectName ? `${role} in project "${projectName}"` : `${role} in "${organizationName}"`;
  const subject = `You're invited to join ${organizationName} on KlanServiceHub`;
  const text = `${inviterName} has invited you to collaborate as a ${roleText} on KlanServiceHub.\n\n` +
    (password ? `Your login credentials:\nEmail: ${to}\nTemporary Password: ${password}\n\n` : '') +
    `Accept invitation & log in here: ${inviteUrl}`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; margin: 0; padding: 24px; color: #f1f5f9; }
          .container { max-width: 540px; margin: 0 auto; background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          .header { background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%); padding: 28px 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
          .content { padding: 36px 28px; text-align: center; }
          .title { font-size: 22px; font-weight: 700; margin-top: 0; margin-bottom: 16px; color: #ffffff; }
          .desc { font-size: 14px; color: #94a3b8; line-height: 1.6; margin-bottom: 24px; }
          .cred-box { background: #0f172a; border: 1px solid #3b82f6; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: left; }
          .cred-title { font-size: 11px; font-weight: 700; color: #60a5fa; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
          .cred-row { margin-bottom: 8px; font-size: 13px; color: #cbd5e1; }
          .cred-label { color: #94a3b8; font-size: 12px; }
          .cred-val { font-family: 'Courier New', Courier, monospace; font-size: 15px; font-weight: 700; color: #ffffff; background: #1e293b; padding: 4px 8px; border-radius: 6px; display: inline-block; margin-top: 2px; }
          .cta-btn { display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: #ffffff !important; padding: 14px 32px; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 10px; margin: 16px 0 20px; box-shadow: 0 10px 20px rgba(37,99,235,0.3); }
          .link-box { word-break: break-all; font-size: 12px; color: #60a5fa; margin-top: 8px; }
          .footer { padding: 20px 24px; background: #0f172a; border-top: 1px solid #334155; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>KlanServiceHub</h1>
          </div>
          <div class="content">
            <h2 class="title">You're Invited to Join ${organizationName}!</h2>
            <p class="desc"><strong>${inviterName}</strong> has invited you to collaborate as a <strong>${roleText}</strong> on KlanServiceHub.</p>
            
            ${password ? `
            <div class="cred-box">
              <div class="cred-title">🔑 Your Account Credentials</div>
              <div class="cred-row">
                <div class="cred-label">Login Email:</div>
                <div class="cred-val">${to}</div>
              </div>
              <div class="cred-row" style="margin-top: 10px;">
                <div class="cred-label">Temporary Password:</div>
                <div class="cred-val" style="color: #60a5fa; border: 1px dashed #3b82f6;">${password}</div>
              </div>
              <p style="font-size: 11px; color: #64748b; margin: 10px 0 0 0;">You can change your password anytime after logging in from your profile settings.</p>
            </div>
            ` : ''}

            <a href="${inviteUrl}" class="cta-btn" target="_blank">Accept Invitation & Log In</a>
            <p style="color: #64748b; font-size: 12px; margin-top: 24px;">
              Or copy and paste this link into your browser:<br>
              <a href="${inviteUrl}" class="link-box">${inviteUrl}</a>
            </p>
            <p style="color: #475569; font-size: 11px; margin-top: 20px;">This invitation is valid for 7 days.</p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} KlanServiceHub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  return await dispatchEmail({ to, subject, text, html });
}

/**
 * Send Password Reset Email with Verification OTP and Direct Link
 */
export async function sendPasswordResetEmail({
  to,
  userName = 'there',
  otpCode,
  resetUrl,
}) {
  if (!to || !otpCode || !resetUrl) {
    throw new Error('Recipient email, OTP code, and reset URL are required.');
  }

  const subject = `Reset Your KlanServiceHub Password: Code ${otpCode}`;
  const text = `Hi ${userName},\n\nYour KlanServiceHub password reset verification code is: ${otpCode}.\n\nDirect reset link: ${resetUrl}\n\nThis code and link are valid for 15 minutes.`;

  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; margin: 0; padding: 24px; color: #f1f5f9; }
          .container { max-width: 540px; margin: 0 auto; background: #1e293b; border-radius: 16px; border: 1px solid #334155; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
          .header { background: linear-gradient(135deg, #2563eb 0%, #4f46e5 100%); padding: 28px 24px; text-align: center; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
          .content { padding: 36px 28px; text-align: center; }
          .title { font-size: 22px; font-weight: 700; margin-top: 0; margin-bottom: 12px; color: #ffffff; }
          .sub { color: #94a3b8; font-size: 14px; margin-bottom: 24px; line-height: 1.6; }
          .code-box { background: #0f172a; border: 2px dashed #3b82f6; border-radius: 12px; text-align: center; padding: 18px; margin: 20px auto; max-width: 300px; }
          .code-label { font-size: 11px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
          .code { font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #60a5fa; }
          .cta-btn { display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: #ffffff !important; padding: 14px 32px; font-size: 15px; font-weight: 700; text-decoration: none; border-radius: 10px; margin: 16px 0 20px; box-shadow: 0 10px 20px rgba(37,99,235,0.3); }
          .link-box { word-break: break-all; font-size: 12px; color: #60a5fa; margin-top: 8px; }
          .footer { padding: 20px 24px; background: #0f172a; border-top: 1px solid #334155; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>KlanServiceHub</h1>
          </div>
          <div class="content">
            <h2 class="title">Reset Your Password</h2>
            <p class="sub">
              Hi ${userName},<br>
              We received a request to reset the password for your KlanServiceHub account. Use the verification OTP code below or click the direct reset link.
            </p>

            <div class="code-box">
              <div class="code-label">Verification OTP Code</div>
              <div class="code">${otpCode}</div>
            </div>

            <p style="font-size: 13px; color: #94a3b8; margin: 20px 0 8px;">Or click the button below to reset immediately:</p>
            <a href="${resetUrl}" class="cta-btn" target="_blank">Reset Password Now</a>

            <p style="color: #64748b; font-size: 12px; margin-top: 24px;">
              Direct link:<br>
              <a href="${resetUrl}" class="link-box">${resetUrl}</a>
            </p>

            <p style="color: #475569; font-size: 11px; margin-top: 20px;">
              This code and link are valid for <strong>15 minutes</strong>. If you did not request a password reset, you can safely ignore this message.
            </p>
          </div>
          <div class="footer">
            &copy; ${new Date().getFullYear()} KlanServiceHub. All rights reserved.
          </div>
        </div>
      </body>
    </html>
  `;

  return await dispatchEmail({ to, subject, text, html });
}
