-- ==============================================================================
-- KlanServiceHub - Cloudflare D1 Super Admin & Security Schema Migration
-- ==============================================================================

-- 1. Alter sessions table to support dedicated Super Admin session state & MFA
ALTER TABLE sessions ADD COLUMN is_super_admin_session INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN mfa_verified INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN mfa_secret TEXT;

-- 2. Create platform_audit_logs table for platform-wide immutable governance
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  target_name TEXT,
  details TEXT,
  ip_address TEXT DEFAULT '127.0.0.1',
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_created ON platform_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_logs_action ON platform_audit_logs(action);

-- 3. Create super_admin_mfa table for rate-limited, time-restricted cryptographic challenge tokens
CREATE TABLE IF NOT EXISTS super_admin_mfa (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  attempt_count INTEGER DEFAULT 0,
  verified INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_super_admin_mfa_email ON super_admin_mfa(email, expires_at);

-- 4. Provision Fixed Unique Master Super Admin Account
-- Email: superadmin@klanservicehub.com
-- Password: KlanMaster#2026!SecuredAdmin
INSERT INTO users (id, name, email, password_hash, job_title, department, status, is_super_admin)
VALUES (
  'superadmin-master-root-001',
  'Platform Super Admin',
  'superadmin@klanservicehub.com',
  '$2b$10$DqOv/QBXGbvccDNm9tuRRO7QUKwg/pSgQQbcinHmzguOc9Bav/ooK',
  'Master Administrator',
  'Platform Security',
  'ACTIVE',
  1
)
ON CONFLICT(email) DO UPDATE SET
  password_hash = '$2b$10$DqOv/QBXGbvccDNm9tuRRO7QUKwg/pSgQQbcinHmzguOc9Bav/ooK',
  is_super_admin = 1,
  status = 'ACTIVE',
  name = 'Platform Super Admin';
