import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';

let dbPath = ':memory:';
try {
  const metaUrl = typeof import.meta !== 'undefined' ? import.meta?.url : undefined;
  if (metaUrl && typeof metaUrl === 'string' && metaUrl.startsWith('file:')) {
    const __dirname = path.dirname(fileURLToPath(metaUrl));
    dbPath = path.resolve(__dirname, '../jira.db');
  } else if (typeof process !== 'undefined' && process.cwd && typeof path?.resolve === 'function') {
    dbPath = path.resolve(process.cwd(), 'jira.db');
  }
} catch (e) {
  dbPath = ':memory:';
}

export class MemoryDb {
  constructor() {
    this.tables = new Map();
    this.activeD1 = null;
    this.activeCtx = null;
    this.isD1Synced = false;
  }

  getTable(name) {
    const clean = name.toLowerCase().replace(/[`"']/g, '').trim();
    if (!this.tables.has(clean)) {
      this.tables.set(clean, []);
    }
    return this.tables.get(clean);
  }

  exec(sql) {
    if (!sql || typeof sql !== 'string') return;
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      if (/^PRAGMA/i.test(stmt)) continue;
      if (/^CREATE TABLE/i.test(stmt)) {
        const match = stmt.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i);
        if (match) this.getTable(match[1]);
        continue;
      }
      if (/^ALTER TABLE/i.test(stmt)) {
        continue;
      }
      try {
        this.prepare(stmt).run();
      } catch (e) {
        // ignore init errors
      }
    }
  }

  transaction(fn) {
    return (...args) => fn(...args);
  }

  prepare(rawSql) {
    const memDb = this;
    const sql = rawSql.trim();

    return {
      run(...params) {
        return memDb._executeWrite(sql, params);
      },
      get(...params) {
        const rows = memDb._executeSelect(sql, params);
        return rows.length > 0 ? rows[0] : undefined;
      },
      all(...params) {
        return memDb._executeSelect(sql, params);
      },
    };
  }

  _executeWrite(sql, params) {
    // Cloudflare D1 live asynchronous mirroring
    if (this.activeD1 && typeof this.activeD1.prepare === 'function') {
      try {
        const d1Promise = this.activeD1.prepare(sql).bind(...params).run().catch((err) => {
          console.warn('[D1_WRITE_SYNC_ERROR]:', err?.message || err, 'SQL:', sql);
        });
        if (this.activeCtx && typeof this.activeCtx.waitUntil === 'function') {
          this.activeCtx.waitUntil(d1Promise);
        }
      } catch (e) {
        console.warn('[D1_PREPARE_ERROR]:', e?.message || e);
      }
    }

    const insertMatch = sql.match(/INSERT\s+(?:OR\s+IGNORE\s+|OR\s+REPLACE\s+)?INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const tableName = insertMatch[1].toLowerCase().replace(/[`"']/g, '').trim();
      const cols = insertMatch[2].split(',').map((c) => c.trim().replace(/[`"']/g, ''));
      const table = this.getTable(tableName);
      
      const newRow = {
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      
      let paramIdx = 0;
      for (const col of cols) {
        if (paramIdx < params.length) {
          newRow[col] = params[paramIdx++];
        } else {
          newRow[col] = null;
        }
      }

      if (!newRow.id && cols.includes('id')) {
        newRow.id = randomUUID();
      }

      if (newRow.id) {
        const existingIdx = table.findIndex((r) => r.id === newRow.id);
        if (existingIdx !== -1) {
          table[existingIdx] = { ...table[existingIdx], ...newRow };
          return { changes: 1, lastInsertRowid: existingIdx + 1 };
        }
      }

      table.push(newRow);
      return { changes: 1, lastInsertRowid: table.length };
    }

    const updateMatch = sql.match(/UPDATE\s+([^\s]+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
    if (updateMatch) {
      const tableName = updateMatch[1].toLowerCase().replace(/[`"']/g, '').trim();
      const setClause = updateMatch[2];
      const whereClause = updateMatch[3];
      const table = this.getTable(tableName);

      const setAssignments = setClause.split(',').map((s) => s.trim());
      const setCols = [];
      let setValuesCount = 0;
      for (const assign of setAssignments) {
        const parts = assign.split('=');
        if (parts.length === 2) {
          const col = parts[0].trim().replace(/[`"']/g, '');
          const valExpr = parts[1].trim();
          setCols.push({ col, valExpr });
          if (valExpr === '?') setValuesCount++;
        }
      }

      const setParams = params.slice(0, setValuesCount);
      const whereParams = params.slice(setValuesCount);

      let changed = 0;
      for (let i = 0; i < table.length; i++) {
        const row = table[i];
        if (!whereClause || this._rowMatchesWhere(row, whereClause, whereParams)) {
          let pIdx = 0;
          for (const s of setCols) {
            if (s.valExpr === '?') {
              row[s.col] = setParams[pIdx++];
            } else if (s.valExpr === 'CURRENT_TIMESTAMP') {
              row[s.col] = new Date().toISOString();
            } else if (/^[0-9]+$/.test(s.valExpr)) {
              row[s.col] = Number(s.valExpr);
            } else {
              row[s.col] = s.valExpr.replace(/^['"]|['"]$/g, '');
            }
          }
          row.updated_at = new Date().toISOString();
          changed++;
        }
      }
      return { changes: changed, lastInsertRowid: 0 };
    }

    const deleteMatch = sql.match(/DELETE\s+FROM\s+([^\s]+)(?:\s+WHERE\s+(.+))?$/i);
    if (deleteMatch) {
      const tableName = deleteMatch[1].toLowerCase().replace(/[`"']/g, '').trim();
      const whereClause = deleteMatch[2];
      const table = this.getTable(tableName);

      if (!whereClause) {
        const count = table.length;
        this.tables.set(tableName, []);
        return { changes: count, lastInsertRowid: 0 };
      }

      const initialLength = table.length;
      const remaining = table.filter((row) => !this._rowMatchesWhere(row, whereClause, params));
      this.tables.set(tableName, remaining);
      return { changes: initialLength - remaining.length, lastInsertRowid: 0 };
    }

    return { changes: 0, lastInsertRowid: 0 };
  }

  _executeSelect(sql, params) {
    const isCount = /SELECT\s+COUNT\s*\(/i.test(sql);

    const fromMatch = sql.match(/FROM\s+([^\s,]+)(?:\s+(?:AS\s+)?([^\s,]+))?(?:\s+JOIN\s+([^\s,]+)(?:\s+(?:AS\s+)?([^\s,]+))?\s+ON\s+([^\s]+)\s*=\s*([^\s]+))?(?:\s+WHERE\s+(.+?))?(?:\s+GROUP\s+BY\s+.+?)?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+([0-9]+|\?))?$/i);
    
    if (!fromMatch) {
      return [];
    }

    const table1Name = fromMatch[1].toLowerCase().replace(/[`"']/g, '').trim();
    const table1Alias = fromMatch[2] ? fromMatch[2].toLowerCase().replace(/[`"']/g, '').trim() : table1Name;
    const table2Name = fromMatch[3] ? fromMatch[3].toLowerCase().replace(/[`"']/g, '').trim() : null;
    const table2Alias = fromMatch[4] ? fromMatch[4].toLowerCase().replace(/[`"']/g, '').trim() : table2Name;
    const joinCol1 = fromMatch[5];
    const joinCol2 = fromMatch[6];
    const whereClause = fromMatch[7];
    const orderByClause = fromMatch[8];
    const limitClause = fromMatch[9];

    let rows = [];
    const t1 = this.getTable(table1Name);

    if (table2Name) {
      const t2 = this.getTable(table2Name);
      for (const r1 of t1) {
        for (const r2 of t2) {
          const combined = { ...r1, ...r2 };
          let joinMatch = true;
          if (joinCol1 && joinCol2) {
            const getVal = (colExpr) => {
              const parts = colExpr.split('.');
              const col = parts.length > 1 ? parts[1].replace(/[`"']/g, '') : parts[0].replace(/[`"']/g, '');
              const alias = parts.length > 1 ? parts[0].toLowerCase() : null;
              if (alias === table1Alias) return r1[col];
              if (alias === table2Alias) return r2[col];
              return r1[col] ?? r2[col];
            };
            joinMatch = getVal(joinCol1) == getVal(joinCol2);
          }
          if (joinMatch) {
            rows.push(combined);
          }
        }
      }
    } else {
      rows = t1.map((r) => ({ ...r }));
    }

    if (whereClause) {
      rows = rows.filter((row) => this._rowMatchesWhere(row, whereClause, params));
    }

    if (isCount) {
      return [{ count: rows.length, c: rows.length, 'count(*)': rows.length }];
    }

    if (orderByClause) {
      const isDesc = /DESC/i.test(orderByClause);
      const orderCol = orderByClause.replace(/ASC|DESC/gi, '').split(',')[0].trim().replace(/[`"']/g, '');
      const cleanCol = orderCol.includes('.') ? orderCol.split('.')[1] : orderCol;
      rows.sort((a, b) => {
        const valA = a[cleanCol] ?? '';
        const valB = b[cleanCol] ?? '';
        if (valA < valB) return isDesc ? 1 : -1;
        if (valA > valB) return isDesc ? -1 : 1;
        return 0;
      });
    }

    if (limitClause) {
      const limitNum = limitClause === '?' ? Number(params[params.length - 1]) : Number(limitClause);
      if (!isNaN(limitNum) && limitNum > 0) {
        rows = rows.slice(0, limitNum);
      }
    }

    return rows;
  }

  _rowMatchesWhere(row, whereClause, params) {
    if (!whereClause) return true;
    
    let pIdx = 0;
    const conditions = whereClause.split(/\s+AND\s+/i);

    for (const cond of conditions) {
      const trimmed = cond.trim();
      if (!trimmed) continue;

      if (/datetime\(expires_at\)\s*>\s*datetime\('now'\)/i.test(trimmed)) {
        if (!row.expires_at || new Date(row.expires_at).getTime() <= Date.now()) {
          return false;
        }
        continue;
      }

      // Check IS NOT NULL
      const isNotNullMatch = trimmed.match(/([^\s]+)\s+IS\s+NOT\s+NULL/i);
      if (isNotNullMatch) {
        let col = isNotNullMatch[1].trim().replace(/[`"']/g, '');
        if (col.includes('.')) col = col.split('.')[1];
        if (row[col] === null || row[col] === undefined) return false;
        continue;
      }

      // Check IS NULL
      const isNullMatch = trimmed.match(/([^\s]+)\s+IS\s+NULL/i);
      if (isNullMatch) {
        let col = isNullMatch[1].trim().replace(/[`"']/g, '');
        if (col.includes('.')) col = col.split('.')[1];
        if (row[col] !== null && row[col] !== undefined) return false;
        continue;
      }

      // Check IN (...)
      const inMatch = trimmed.match(/([^\s]+)\s+IN\s*\(([^)]+)\)/i);
      if (inMatch) {
        let col = inMatch[1].trim().replace(/[`"']/g, '');
        if (col.includes('.')) col = col.split('.')[1];
        const inside = inMatch[2].split(',').map(s => s.trim());
        const allowed = inside.map(item => {
          if (item === '?') return params[pIdx++];
          return item.replace(/^['"]|['"]$/g, '');
        });
        if (!allowed.map(String).includes(String(row[col] ?? ''))) return false;
        continue;
      }

      const eqMatch = trimmed.match(/([^\s=!<]+)\s*(=|!=|<>|LIKE|<|<=|>|>=)\s*(.+)/i);
      if (eqMatch) {
        let col = eqMatch[1].trim().replace(/[`"']/g, '');
        if (col.includes('.')) col = col.split('.')[1];
        const op = eqMatch[2].toUpperCase();
        let target = eqMatch[3].trim();

        let expectedValue;
        if (target === '?') {
          expectedValue = params[pIdx++];
        } else if (/^[0-9]+$/.test(target)) {
          expectedValue = Number(target);
        } else if (/^NULL$/i.test(target)) {
          expectedValue = null;
        } else {
          expectedValue = target.replace(/^['"]|['"]$/g, '');
        }

        const actualValue = row[col];

        if (op === '=') {
          if (expectedValue === null) {
            if (actualValue !== null && actualValue !== undefined) return false;
          } else {
            if (String(actualValue ?? '').toLowerCase() !== String(expectedValue ?? '').toLowerCase()) return false;
          }
        } else if (op === '!=' || op === '<>') {
          if (String(actualValue ?? '').toLowerCase() === String(expectedValue ?? '').toLowerCase()) return false;
        } else if (op === 'LIKE') {
          const pattern = String(expectedValue ?? '').replace(/%/g, '.*');
          const regex = new RegExp(`^${pattern}$`, 'i');
          if (!regex.test(String(actualValue ?? ''))) return false;
        } else if (op === '>') {
          if (Number(actualValue) <= Number(expectedValue)) return false;
        } else if (op === '>=') {
          if (Number(actualValue) < Number(expectedValue)) return false;
        } else if (op === '<') {
          if (Number(actualValue) >= Number(expectedValue)) return false;
        } else if (op === '<=') {
          if (Number(actualValue) > Number(expectedValue)) return false;
        }
      }
    }

    return true;
  }
}

let dbInstance;
try {
  if (typeof DatabaseSync === 'function') {
    dbInstance = new DatabaseSync(dbPath);
  }
} catch (e) {
  try {
    if (typeof DatabaseSync === 'function') {
      dbInstance = new DatabaseSync(':memory:');
    }
  } catch (err) {
    // DatabaseSync not available in this runtime/isolate
  }
}

if (!dbInstance || typeof dbInstance.exec !== 'function') {
  dbInstance = new MemoryDb();
}

export const db = dbInstance;

let d1SyncPromise = null;

// Helper to bind and sync Cloudflare D1 with the application
export async function initOrSyncD1(d1, executionCtx) {
  if (!d1) return;

  if (db instanceof MemoryDb) {
    db.activeD1 = d1;
    db.activeCtx = executionCtx;
  }

  if (d1SyncPromise) {
    return d1SyncPromise;
  }

  d1SyncPromise = (async () => {
    try {
      // 1. Check if core tables exist in Cloudflare D1
      let tableCheck = null;
      try {
        tableCheck = await d1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'users'").first();
      } catch (e) {
        tableCheck = null;
      }

      if (!tableCheck) {
        console.log('[D1_INIT] Initializing schema on remote D1 database...');
        const statements = SCHEMA_SQL.split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.startsWith('--') && !s.toUpperCase().startsWith('PRAGMA'));

        for (const stmt of statements) {
          try {
            await d1.prepare(stmt).run();
          } catch (e) {
            // Ignore minor duplicate/create errors
          }
        }
      }

      // 2. Hydrate in-memory tables from D1
      if (db instanceof MemoryDb) {
        const ALL_TABLE_NAMES = [
          'users', 'sessions', 'email_verifications', 'workspaces', 'members',
          'invitations', 'roles', 'permissions', 'role_permissions', 'user_roles',
          'teams', 'team_members', 'team_projects', 'projects', 'issue_types',
          'workflows', 'workflow_statuses', 'workflow_transitions', 'sprints',
          'boards', 'dashboards', 'dashboard_gadgets', 'tasks', 'task_assignees',
          'task_comments', 'task_watchers', 'task_history', 'task_attachments',
          'task_links', 'activities', 'work_logs', 'project_components',
          'saved_filters', 'custom_fields', 'task_custom_field_values',
          'issue_type_schemes', 'priority_schemes', 'sla_definitions', 'sla_records',
          'webhooks', 'webhook_deliveries', 'user_favorites', 'user_recent_items',
          'api_tokens', 'audit_logs', 'notifications', 'automations', 'automation_logs',
          'releases', 'project_groups', 'group_members', 'user_security',
          'security_events', 'trusted_devices', 'two_factor_auth', 'sso_configurations',
          'ip_allowlists', 'integrations', 'integration_sync_logs', 'billing_subscriptions',
          'billing_invoices', 'data_exports', 'data_backups', 'data_imports',
          'retention_policies', 'retention_execution_logs'
        ];

        for (const tbl of ALL_TABLE_NAMES) {
          try {
            const res = await d1.prepare(`SELECT * FROM ${tbl}`).all();
            if (res && Array.isArray(res.results)) {
              db.tables.set(tbl, res.results);
            }
          } catch (e) {
            // Table might not exist yet, ignore
          }
        }
        db.isD1Synced = true;
        console.log('[D1_INIT] Successfully hydrated tables from D1 into isolate memory.');
      }
    } catch (err) {
      console.error('[D1_HYDRATION_ERROR]:', err);
    }
  })();

  return d1SyncPromise;
}

// Enable WAL mode, busy timeout, and foreign keys
try {
  if (db && typeof db.exec === 'function') {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
  }
} catch (e) {
  // Ignored in environments that don't support PRAGMA or memory db
}

// Helper to safely add column if it doesn't exist
function safeAddColumn(table, columnDef) {
  try {
    if (db && typeof db.exec === 'function') {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef};`);
    }
  } catch (e) {
    // Column likely already exists, ignore
  }
}

// Master Schema Definitions
export const SCHEMA_SQL = `
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      invite_code TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'MEMBER',
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, SUSPENDED, PENDING
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL, -- COMPANY, PROJECT, ISSUE
      description TEXT
    );

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

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_code TEXT NOT NULL,
      PRIMARY KEY (role_id, permission_code)
    );

    CREATE TABLE IF NOT EXISTS user_roles (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, user_id, role_id)
    );

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

    CREATE TABLE IF NOT EXISTS issue_types (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'bookmark',
      color TEXT NOT NULL DEFAULT '#4F46E5',
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'KANBAN', -- KANBAN, SCRUM
      config TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      layout TEXT NOT NULL DEFAULT '2_COLUMN_EQUAL',
      is_default INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      share_scope TEXT NOT NULL DEFAULT 'PUBLIC',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dashboard_gadgets (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      gadget_type TEXT NOT NULL,
      title TEXT NOT NULL,
      column_index INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      settings TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      due_date DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_assignees (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(task_id, member_id)
    );

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

    CREATE TABLE IF NOT EXISTS task_links (
      id TEXT PRIMARY KEY,
      source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL DEFAULT 'relates to', -- blocks, is blocked by, relates to, duplicates, is duplicated by
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS custom_fields (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      field_type TEXT NOT NULL DEFAULT 'TEXT', -- TEXT, TEXTAREA, NUMBER, DATE, DATETIME, BOOLEAN, SELECT, MULTI_SELECT, USER, VERSION, URL
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
      status TEXT NOT NULL DEFAULT 'RUNNING', -- RUNNING, PAUSED, COMPLETED, BREACHED
      target_minutes INTEGER NOT NULL,
      elapsed_minutes INTEGER DEFAULT 0,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      breached_at DATETIME
    );

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

    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS release_trains (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      target_date DATETIME,
      status TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED, IN_PROGRESS, READY, RELEASED, CANCELLED
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
      type TEXT NOT NULL, -- SPRINT, RELEASE, VERSION, HOLIDAY, LEAVE, MILESTONE, DEPLOYMENT
      title TEXT NOT NULL,
      start_at DATETIME NOT NULL,
      end_at DATETIME NOT NULL,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'CONFIRMED',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      target_date DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'PLANNED', -- PLANNED, IN_PROGRESS, AT_RISK, COMPLETED, CANCELLED
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS project_risks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      probability TEXT NOT NULL DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH
      impact TEXT NOT NULL DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH
      severity TEXT NOT NULL DEFAULT 'MEDIUM', -- LOW, MEDIUM, HIGH, CRITICAL
      mitigation TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN, MITIGATED, CLOSED
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
      status TEXT NOT NULL DEFAULT 'APPROVED', -- PROPOSED, APPROVED, REJECTED, SUPERSEDED
      decided_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      resource_type TEXT NOT NULL, -- RELEASE, PROMOTION, DEPLOYMENT, SCOPE
      resource_id TEXT NOT NULL,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      approver_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, APPROVED, REJECTED, CANCELLED
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
      status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, SUBMITTED, UNDER_REVIEW, APPROVED, REJECTED, IMPLEMENTED
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS service_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_type TEXT NOT NULL DEFAULT 'SERVICE_REQUEST', -- INCIDENT, SERVICE_REQUEST, PROBLEM, CHANGE, QUESTION
      summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      queue_name TEXT DEFAULT 'General Triage',
      priority TEXT DEFAULT 'MEDIUM',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_organizations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      domains TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL, -- SERVER, DATABASE, APPLICATION, DEVICE, SERVICE, CLOUD_RESOURCE
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

    CREATE TABLE IF NOT EXISTS environments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL, -- DEVELOPMENT, TEST, STAGING, PRODUCTION
      type TEXT NOT NULL DEFAULT 'PRODUCTION',
      status TEXT DEFAULT 'HEALTHY',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version_id TEXT REFERENCES releases(id) ON DELETE SET NULL,
      environment TEXT NOT NULL, -- DEVELOPMENT, TEST, STAGING, PRODUCTION
      status TEXT NOT NULL DEFAULT 'SUCCESS', -- PENDING, RUNNING, SUCCESS, FAILED, ROLLED_BACK
      deployed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      status TEXT NOT NULL, -- SUCCESS, FAILED
      details TEXT,
      executed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      type TEXT DEFAULT 'INFO', -- INFO, ASSIGNMENT, STATUS_CHANGE, ALERT, MENTION
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

    CREATE TABLE IF NOT EXISTS integrations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL, -- GITHUB, GITLAB, BITBUCKET, SLACK, WEBHOOK
      name TEXT NOT NULL,
      config TEXT DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'CONNECTED', -- CONNECTED, DISCONNECTED, ERROR
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

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT UNIQUE NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'BUSINESS', -- STARTER, BUSINESS, ENTERPRISE
      billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY', -- MONTHLY, ANNUAL
      user_limit INTEGER DEFAULT 100,
      project_limit INTEGER DEFAULT -1, -- -1 = unlimited
      storage_limit_gb INTEGER DEFAULT 500,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, PAST_DUE, CANCELLED
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
      status TEXT NOT NULL DEFAULT 'PAID', -- PAID, PENDING, FAILED
      invoice_date DATETIME NOT NULL,
      pdf_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'READY',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      layout TEXT NOT NULL DEFAULT '2_COLUMN_EQUAL',
      is_default INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      share_scope TEXT DEFAULT 'PUBLIC',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dashboard_gadgets (
      id TEXT PRIMARY KEY,
      dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      gadget_type TEXT NOT NULL,
      title TEXT NOT NULL,
      column_index INTEGER DEFAULT 0,
      position INTEGER DEFAULT 0,
      settings TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_dashboards_workspace_id ON dashboards(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_dashboard_gadgets_dash_id ON dashboard_gadgets(dashboard_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_secret ON sessions(secret);
    CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
    CREATE INDEX IF NOT EXISTS idx_members_workspace_id ON members(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_members_user_id ON members(user_id);
    CREATE INDEX IF NOT EXISTS idx_projects_workspace_id ON projects(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_issue_type ON tasks(issue_type);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_sprint_id ON tasks(sprint_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
    CREATE INDEX IF NOT EXISTS idx_task_assignees_task_id ON task_assignees(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_assignees_member_id ON task_assignees(member_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace ON audit_logs(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, workspace_id);

    CREATE TABLE IF NOT EXISTS email_verifications (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_domain_rules (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      domain TEXT NOT NULL,
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, domain, group_id)
    );

    CREATE TABLE IF NOT EXISTS project_members (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
`;

// Initialize tables from schema
const initSchema = () => {
  try {
    if (!db || typeof db.exec !== 'function') return;
    db.exec(SCHEMA_SQL);

  // Run safe column additions for existing tables
  safeAddColumn('users', "avatar_url TEXT");
  safeAddColumn('users', "phone TEXT");
  safeAddColumn('users', "job_title TEXT");
  safeAddColumn('users', "department TEXT");
  safeAddColumn('users', "status TEXT NOT NULL DEFAULT 'ACTIVE'");

  safeAddColumn('sessions', "ip_address TEXT DEFAULT '127.0.0.1'");
  safeAddColumn('sessions', "user_agent TEXT DEFAULT 'Web Browser'");
  safeAddColumn('sessions', "device_info TEXT DEFAULT 'Desktop Device'");

  safeAddColumn('workspaces', "description TEXT DEFAULT ''");
  safeAddColumn('workspaces', "website TEXT DEFAULT ''");
  safeAddColumn('workspaces', "email TEXT DEFAULT ''");
  safeAddColumn('workspaces', "phone TEXT DEFAULT ''");
  safeAddColumn('workspaces', "address TEXT DEFAULT ''");
  safeAddColumn('workspaces', "timezone TEXT DEFAULT 'UTC'");
  safeAddColumn('workspaces', "language TEXT DEFAULT 'en-US'");
  safeAddColumn('workspaces', "date_format TEXT DEFAULT 'YYYY-MM-DD'");
  safeAddColumn('workspaces', "currency TEXT DEFAULT 'USD'");
  safeAddColumn('workspaces', "status TEXT DEFAULT 'ACTIVE'");

  safeAddColumn('members', "status TEXT NOT NULL DEFAULT 'ACTIVE'");

  safeAddColumn('projects', "key TEXT DEFAULT 'PROJ'");
  safeAddColumn('projects', "description TEXT DEFAULT ''");
  safeAddColumn('projects', "category TEXT DEFAULT 'Software'");
  safeAddColumn('projects', "lead_id TEXT");
  safeAddColumn('projects', "is_archived INTEGER DEFAULT 0");

  safeAddColumn('tasks', "reporter_id TEXT");
  safeAddColumn('tasks', "sprint_id TEXT");
  safeAddColumn('tasks', "issue_type TEXT NOT NULL DEFAULT 'Task'");
  safeAddColumn('tasks', "key TEXT");
  safeAddColumn('tasks', "priority TEXT NOT NULL DEFAULT 'MEDIUM'");
  safeAddColumn('tasks', "labels TEXT DEFAULT '[]'");
  safeAddColumn('tasks', "story_points REAL DEFAULT 1");
  safeAddColumn('tasks', "epic_id TEXT");
  safeAddColumn('tasks', "parent_task_id TEXT");
  safeAddColumn('tasks', "release_id TEXT");
  safeAddColumn('tasks', "original_estimate_hours REAL DEFAULT 0");
  safeAddColumn('tasks', "logged_hours REAL DEFAULT 0");
  safeAddColumn('tasks', "components TEXT DEFAULT '[]'");
  safeAddColumn('password_resets', 'user_id TEXT');
  safeAddColumn('password_resets', 'attempt_count INTEGER DEFAULT 0');
  safeAddColumn('service_requests', "description TEXT DEFAULT ''");
  safeAddColumn('service_requests', "sla_due_at DATETIME");
  safeAddColumn('service_requests', "sla_first_response_due_at DATETIME");
  safeAddColumn('service_requests', "sla_breached INTEGER DEFAULT 0");
  safeAddColumn('service_requests', "resolved_at DATETIME");
  safeAddColumn('service_requests', "satisfaction_rating INTEGER");
  safeAddColumn('service_requests', "assigned_agent_id TEXT");
  safeAddColumn('service_requests', "customer_org_id TEXT");

  // Run safe column additions for existing tables
  safeAddColumn('users', "avatar_url TEXT");
  safeAddColumn('users', "phone TEXT");
  safeAddColumn('users', "job_title TEXT");
  safeAddColumn('users', "department TEXT");
  safeAddColumn('users', "status TEXT NOT NULL DEFAULT 'ACTIVE'");
  safeAddColumn('users', "onboarding_status TEXT NOT NULL DEFAULT 'REGISTERED'");
  safeAddColumn('users', "display_name TEXT DEFAULT ''");
  safeAddColumn('users', "location TEXT DEFAULT ''");
  safeAddColumn('users', "industry TEXT DEFAULT ''");
  safeAddColumn('users', "company_size TEXT DEFAULT ''");

  safeAddColumn('sessions', "ip_address TEXT DEFAULT '127.0.0.1'");
  safeAddColumn('sessions', "user_agent TEXT DEFAULT 'Web Browser'");
  safeAddColumn('sessions', "device_info TEXT DEFAULT 'Desktop Device'");

  safeAddColumn('workspaces', "description TEXT DEFAULT ''");
  safeAddColumn('workspaces', "website TEXT DEFAULT ''");
  safeAddColumn('workspaces', "email TEXT DEFAULT ''");
  safeAddColumn('workspaces', "phone TEXT DEFAULT ''");
  safeAddColumn('workspaces', "address TEXT DEFAULT ''");
  safeAddColumn('workspaces', "timezone TEXT DEFAULT 'UTC'");
  safeAddColumn('workspaces', "language TEXT DEFAULT 'en-US'");
  safeAddColumn('workspaces', "date_format TEXT DEFAULT 'YYYY-MM-DD'");
  safeAddColumn('workspaces', "currency TEXT DEFAULT 'USD'");
  safeAddColumn('workspaces', "status TEXT DEFAULT 'ACTIVE'");
  safeAddColumn('workspaces', "domain_slug TEXT DEFAULT ''");
  safeAddColumn('workspaces', "industry TEXT DEFAULT ''");
  safeAddColumn('workspaces', "company_size TEXT DEFAULT ''");
  safeAddColumn('workspaces', "country TEXT DEFAULT 'India'");
  safeAddColumn('workspaces', "onboarding_completed INTEGER DEFAULT 1");

  safeAddColumn('members', "status TEXT NOT NULL DEFAULT 'ACTIVE'");
  safeAddColumn('members', "organization_role TEXT NOT NULL DEFAULT 'MEMBER'");
  safeAddColumn('members', "license_tier TEXT DEFAULT 'SOFTWARE_DEVELOPER'");
  safeAddColumn('members', "monthly_cost_inr INTEGER DEFAULT 650");
  safeAddColumn('subscriptions', "currency TEXT DEFAULT 'INR'");
  safeAddColumn('invoices', "currency TEXT DEFAULT 'INR'");

  safeAddColumn('projects', "key TEXT DEFAULT 'PROJ'");
  safeAddColumn('projects', "description TEXT DEFAULT ''");
  safeAddColumn('projects', "category TEXT DEFAULT 'Software'");
  safeAddColumn('projects', "lead_id TEXT");
  safeAddColumn('projects', "is_archived INTEGER DEFAULT 0");

  safeAddColumn('tasks', "reporter_id TEXT");
  safeAddColumn('tasks', "sprint_id TEXT");
  safeAddColumn('tasks', "issue_type TEXT NOT NULL DEFAULT 'Task'");
  safeAddColumn('tasks', "key TEXT");
  safeAddColumn('tasks', "priority TEXT NOT NULL DEFAULT 'MEDIUM'");
  safeAddColumn('tasks', "labels TEXT DEFAULT '[]'");
  safeAddColumn('tasks', "story_points REAL DEFAULT 1");
  safeAddColumn('tasks', "epic_id TEXT");
  safeAddColumn('tasks', "parent_task_id TEXT");
  safeAddColumn('tasks', "release_id TEXT");
  safeAddColumn('tasks', "original_estimate_hours REAL DEFAULT 0");
  safeAddColumn('tasks', "logged_hours REAL DEFAULT 0");
  safeAddColumn('tasks', "components TEXT DEFAULT '[]'");
  safeAddColumn('tasks', "environment TEXT DEFAULT ''");
  safeAddColumn('tasks', "fix_version_id TEXT");
  safeAddColumn('tasks', "affects_version_id TEXT");
  safeAddColumn('tasks', "original_estimate_seconds INTEGER DEFAULT 0");
  safeAddColumn('tasks', "remaining_estimate_seconds INTEGER DEFAULT 0");
  safeAddColumn('tasks', "time_spent_seconds INTEGER DEFAULT 0");
  safeAddColumn('tasks', "version_number INTEGER DEFAULT 1");

  safeAddColumn('groups', "is_default INTEGER DEFAULT 0");
  safeAddColumn('groups', "is_system INTEGER DEFAULT 0");
  safeAddColumn('groups', "group_type TEXT DEFAULT 'CUSTOM'");
  safeAddColumn('groups', "role_mapping TEXT DEFAULT 'MEMBER'");

    seedDefaultPermissions();
  } catch (err) {
    // Ignore schema init errors in serverless isolate
  }
};

// Comprehensive Standard permissions catalogue (72 Granular Permissions)
export const SYSTEM_PERMISSIONS = [
  // COMPANY
  { code: 'COMPANY_SETTINGS_VIEW', name: 'View Company Settings', category: 'COMPANY', description: 'View company profile, branding, and details' },
  { code: 'COMPANY_SETTINGS_MANAGE', name: 'Manage Company Settings', category: 'COMPANY', description: 'Edit company profile, branding, locale, and lifecycle' },
  { code: 'COMPANY_DELETE', name: 'Delete Company', category: 'COMPANY', description: 'Permanently delete company workspace' },
  { code: 'COMPANY_OWNERSHIP_TRANSFER', name: 'Transfer Company Ownership', category: 'COMPANY', description: 'Authorize and transfer owner rights' },

  // USER
  { code: 'USER_CREATE', name: 'Create Users', category: 'USER', description: 'Create and provision user accounts' },
  { code: 'USER_VIEW', name: 'View Users', category: 'USER', description: 'View organization user directory' },
  { code: 'USER_UPDATE', name: 'Update Users', category: 'USER', description: 'Update profile and metadata of users' },
  { code: 'USER_DELETE', name: 'Delete Users', category: 'USER', description: 'Remove users from workspace' },
  { code: 'USER_SUSPEND', name: 'Suspend Users', category: 'USER', description: 'Suspend active user access' },
  { code: 'USER_ACTIVATE', name: 'Activate Users', category: 'USER', description: 'Restore suspended user accounts' },
  { code: 'USER_ROLE_ASSIGN', name: 'Assign User Roles', category: 'USER', description: 'Assign roles and permissions to users' },

  // ROLE
  { code: 'ROLE_CREATE', name: 'Create Roles', category: 'ROLE', description: 'Create custom RBAC roles' },
  { code: 'ROLE_VIEW', name: 'View Roles', category: 'ROLE', description: 'View configured roles and permissions' },
  { code: 'ROLE_UPDATE', name: 'Update Roles', category: 'ROLE', description: 'Edit role names and descriptions' },
  { code: 'ROLE_DELETE', name: 'Delete Roles', category: 'ROLE', description: 'Remove custom roles' },
  { code: 'ROLE_PERMISSION_MANAGE', name: 'Manage Role Permissions', category: 'ROLE', description: 'Modify permission matrix of roles' },

  // TEAM
  { code: 'TEAM_CREATE', name: 'Create Teams', category: 'TEAM', description: 'Create cross-functional teams' },
  { code: 'TEAM_VIEW', name: 'View Teams', category: 'TEAM', description: 'View team directory and memberships' },
  { code: 'TEAM_UPDATE', name: 'Update Teams', category: 'TEAM', description: 'Edit team details and lead' },
  { code: 'TEAM_DELETE', name: 'Delete Teams', category: 'TEAM', description: 'Delete teams' },
  { code: 'TEAM_MEMBER_MANAGE', name: 'Manage Team Members', category: 'TEAM', description: 'Add/remove members from teams' },

  // PROJECT
  { code: 'PROJECT_CREATE', name: 'Create Projects', category: 'PROJECT', description: 'Create new organization projects' },
  { code: 'PROJECT_VIEW', name: 'View Projects', category: 'PROJECT', description: 'Access and view project resources' },
  { code: 'PROJECT_UPDATE', name: 'Update Projects', category: 'PROJECT', description: 'Change project details, keys, categories' },
  { code: 'PROJECT_DELETE', name: 'Delete Projects', category: 'PROJECT', description: 'Permanently remove projects' },
  { code: 'PROJECT_ARCHIVE', name: 'Archive Projects', category: 'PROJECT', description: 'Archive inactive projects' },
  { code: 'PROJECT_RESTORE', name: 'Restore Projects', category: 'PROJECT', description: 'Restore archived projects' },
  { code: 'PROJECT_MEMBER_MANAGE', name: 'Manage Project Members', category: 'PROJECT', description: 'Add/remove members from specific projects' },
  { code: 'PROJECT_PERMISSION_MANAGE', name: 'Manage Project Permissions', category: 'PROJECT', description: 'Configure project-scoped security schemes' },

  // ISSUE
  { code: 'ISSUE_CREATE', name: 'Create Issues', category: 'ISSUE', description: 'Create tasks, stories, bugs, epics' },
  { code: 'ISSUE_VIEW', name: 'View Issues', category: 'ISSUE', description: 'View issue details, fields, and history' },
  { code: 'ISSUE_UPDATE', name: 'Update Issues', category: 'ISSUE', description: 'Update summary, description, priority, dates' },
  { code: 'ISSUE_DELETE', name: 'Delete Issues', category: 'ISSUE', description: 'Permanently remove issues' },
  { code: 'ISSUE_ASSIGN', name: 'Assign Issues', category: 'ISSUE', description: 'Change assignee of issues' },
  { code: 'ISSUE_COMMENT', name: 'Comment on Issues', category: 'ISSUE', description: 'Post comments and discussions' },
  { code: 'ISSUE_COMMENT_DELETE', name: 'Delete Issue Comments', category: 'ISSUE', description: 'Delete comments posted on issues' },
  { code: 'ISSUE_ATTACHMENT', name: 'Attach Files', category: 'ISSUE', description: 'Upload attachments and screenshots' },
  { code: 'ISSUE_ATTACHMENT_DELETE', name: 'Delete Attachments', category: 'ISSUE', description: 'Remove attachments from issues' },
  { code: 'ISSUE_LINK', name: 'Link Issues', category: 'ISSUE', description: 'Create relationships between issues' },
  { code: 'ISSUE_CLONE', name: 'Clone Issues', category: 'ISSUE', description: 'Duplicate existing issues' },
  { code: 'ISSUE_MOVE', name: 'Move Issues', category: 'ISSUE', description: 'Move issues across projects' },
  { code: 'ISSUE_BULK_UPDATE', name: 'Bulk Update Issues', category: 'ISSUE', description: 'Perform bulk actions on issues' },

  // BOARD
  { code: 'BOARD_CREATE', name: 'Create Boards', category: 'BOARD', description: 'Create Kanban and Scrum boards' },
  { code: 'BOARD_VIEW', name: 'View Boards', category: 'BOARD', description: 'View board columns and cards' },
  { code: 'BOARD_UPDATE', name: 'Update Boards', category: 'BOARD', description: 'Edit board columns, WIP limits, and settings' },
  { code: 'BOARD_DELETE', name: 'Delete Boards', category: 'BOARD', description: 'Delete boards' },
  { code: 'BOARD_MANAGE', name: 'Manage Boards', category: 'BOARD', description: 'Full board administration' },

  // SPRINT
  { code: 'SPRINT_CREATE', name: 'Create Sprints', category: 'SPRINT', description: 'Create Scrum sprints' },
  { code: 'SPRINT_VIEW', name: 'View Sprints', category: 'SPRINT', description: 'View sprint backlogs and burndown' },
  { code: 'SPRINT_UPDATE', name: 'Update Sprints', category: 'SPRINT', description: 'Edit sprint dates and goals' },
  { code: 'SPRINT_DELETE', name: 'Delete Sprints', category: 'SPRINT', description: 'Delete sprints' },
  { code: 'SPRINT_START', name: 'Start Sprints', category: 'SPRINT', description: 'Activate future sprints' },
  { code: 'SPRINT_COMPLETE', name: 'Complete Sprints', category: 'SPRINT', description: 'Close active sprints and roll forward' },
  { code: 'SPRINT_MANAGE', name: 'Manage Sprints', category: 'SPRINT', description: 'Full sprint administration' },

  // WORKFLOW
  { code: 'WORKFLOW_CREATE', name: 'Create Workflows', category: 'WORKFLOW', description: 'Design new workflow schemes' },
  { code: 'WORKFLOW_VIEW', name: 'View Workflows', category: 'WORKFLOW', description: 'View workflow statuses and transitions' },
  { code: 'WORKFLOW_UPDATE', name: 'Update Workflows', category: 'WORKFLOW', description: 'Edit statuses and transition rules' },
  { code: 'WORKFLOW_DELETE', name: 'Delete Workflows', category: 'WORKFLOW', description: 'Delete workflows' },
  { code: 'WORKFLOW_MANAGE', name: 'Manage Workflows', category: 'WORKFLOW', description: 'Full workflow administration' },

  // DASHBOARD
  { code: 'DASHBOARD_CREATE', name: 'Create Dashboards', category: 'DASHBOARD', description: 'Create custom dashboards' },
  { code: 'DASHBOARD_VIEW', name: 'View Dashboards', category: 'DASHBOARD', description: 'View gadgets and metrics' },
  { code: 'DASHBOARD_UPDATE', name: 'Update Dashboards', category: 'DASHBOARD', description: 'Edit dashboard layout and gadgets' },
  { code: 'DASHBOARD_DELETE', name: 'Delete Dashboards', category: 'DASHBOARD', description: 'Delete dashboards' },
  { code: 'DASHBOARD_SHARE', name: 'Share Dashboards', category: 'DASHBOARD', description: 'Share dashboards with team' },

  // REPORT
  { code: 'REPORT_VIEW', name: 'View Reports', category: 'REPORT', description: 'View velocity, burndown, cycle time' },
  { code: 'REPORT_EXPORT', name: 'Export Reports', category: 'REPORT', description: 'Export report data to CSV/PDF' },

  // AUTOMATION
  { code: 'AUTOMATION_CREATE', name: 'Create Automations', category: 'AUTOMATION', description: 'Create trigger-action rules' },
  { code: 'AUTOMATION_VIEW', name: 'View Automations', category: 'AUTOMATION', description: 'View automation rules and logs' },
  { code: 'AUTOMATION_UPDATE', name: 'Update Automations', category: 'AUTOMATION', description: 'Edit conditions and actions' },
  { code: 'AUTOMATION_DELETE', name: 'Delete Automations', category: 'AUTOMATION', description: 'Delete automation rules' },
  { code: 'AUTOMATION_ENABLE', name: 'Enable Automations', category: 'AUTOMATION', description: 'Activate automation rules' },
  { code: 'AUTOMATION_DISABLE', name: 'Disable Automations', category: 'AUTOMATION', description: 'Deactivate automation rules' },

  // NOTIFICATION
  { code: 'NOTIFICATION_MANAGE', name: 'Manage Notifications', category: 'NOTIFICATION', description: 'Configure notification preferences' },

  // INTEGRATION
  { code: 'INTEGRATION_VIEW', name: 'View Integrations', category: 'INTEGRATION', description: 'View connected third-party tools' },
  { code: 'INTEGRATION_CREATE', name: 'Connect Integrations', category: 'INTEGRATION', description: 'Add GitHub, Slack, webhooks' },
  { code: 'INTEGRATION_UPDATE', name: 'Update Integrations', category: 'INTEGRATION', description: 'Configure integration payloads' },
  { code: 'INTEGRATION_DELETE', name: 'Disconnect Integrations', category: 'INTEGRATION', description: 'Remove third-party integrations' },
  { code: 'INTEGRATION_MANAGE', name: 'Manage Integrations', category: 'INTEGRATION', description: 'Full integrations management' },

  // API
  { code: 'API_TOKEN_CREATE', name: 'Create API Tokens', category: 'API', description: 'Generate scoped API tokens' },
  { code: 'API_TOKEN_VIEW', name: 'View API Tokens', category: 'API', description: 'List active API tokens' },
  { code: 'API_TOKEN_REVOKE', name: 'Revoke API Tokens', category: 'API', description: 'Revoke and delete API tokens' },

  // SECURITY
  { code: 'SECURITY_SETTINGS_VIEW', name: 'View Security Settings', category: 'SECURITY', description: 'View password policy and sessions' },
  { code: 'SECURITY_SETTINGS_MANAGE', name: 'Manage Security Settings', category: 'SECURITY', description: 'Configure 2FA, password rules' },
  { code: 'SESSION_MANAGE', name: 'Manage Active Sessions', category: 'SECURITY', description: 'Terminate active user sessions' },

  // AUDIT
  { code: 'AUDIT_LOG_VIEW', name: 'View Audit Logs', category: 'AUDIT', description: 'Inspect organization audit trail' },
  { code: 'AUDIT_LOG_EXPORT', name: 'Export Audit Logs', category: 'AUDIT', description: 'Export audit trail to CSV' },

  // DATA
  { code: 'DATA_EXPORT', name: 'Export Data', category: 'DATA', description: 'Export complete JSON archive' },
  { code: 'DATA_IMPORT', name: 'Import / Restore Data', category: 'DATA', description: 'Restore from snapshot backup' },

  // BILLING
  { code: 'BILLING_VIEW', name: 'View Billing', category: 'BILLING', description: 'View subscription and invoices' },
  { code: 'BILLING_MANAGE', name: 'Manage Billing', category: 'BILLING', description: 'Upgrade/downgrade subscription plan' },
  { code: 'SUBSCRIPTION_MANAGE', name: 'Manage Subscription', category: 'BILLING', description: 'Manage seat limits and payment method' },
];

function seedDefaultPermissions() {
  try {
    if (!db || typeof db.prepare !== 'function') return;
    const insertPerm = db.prepare(`
      INSERT OR REPLACE INTO permissions (id, code, name, category, description)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const p of SYSTEM_PERMISSIONS) {
      insertPerm.run(p.code, p.code, p.name, p.category, p.description);
    }
  } catch (err) {
    // Ignore in stub/serverless environment
  }
}

// Seed workspace defaults (Roles, Issue Types, Workflows, Security Policies, Subscriptions, Teams)
export function ensureWorkspaceDefaults(workspaceId, ownerUserId) {
  // 1. System Roles
  const defaultRoles = [
    {
      name: 'Company Owner',
      description: 'Full unconstrained accessibility to the entire organization, billing, and company settings.',
      is_system: 1,
      allPermissions: true,
    },
    {
      name: 'Company Admin',
      description: 'Broad administrative control over day-to-day operations, users, projects, workflows, and boards (excluding ownership transfer/delete).',
      is_system: 1,
      permissions: SYSTEM_PERMISSIONS
        .filter((p) => !['COMPANY_DELETE', 'COMPANY_OWNERSHIP_TRANSFER'].includes(p.code))
        .map((p) => p.code),
    },
    {
      name: 'Project Admin',
      description: 'Full administrative control within assigned projects, boards, and workflows.',
      is_system: 1,
      permissions: [
        'PROJECT_VIEW', 'PROJECT_UPDATE', 'PROJECT_ARCHIVE', 'PROJECT_RESTORE', 'PROJECT_MEMBER_MANAGE',
        'PROJECT_PERMISSION_MANAGE', 'WORKFLOW_VIEW', 'WORKFLOW_CREATE', 'WORKFLOW_UPDATE', 'WORKFLOW_MANAGE',
        'BOARD_VIEW', 'BOARD_CREATE', 'BOARD_UPDATE', 'BOARD_DELETE', 'BOARD_MANAGE',
        'SPRINT_VIEW', 'SPRINT_CREATE', 'SPRINT_UPDATE', 'SPRINT_DELETE', 'SPRINT_START', 'SPRINT_COMPLETE', 'SPRINT_MANAGE',
        'REPORT_VIEW', 'REPORT_EXPORT', 'DASHBOARD_VIEW', 'DASHBOARD_CREATE',
        'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_DELETE', 'ISSUE_ASSIGN', 'ISSUE_COMMENT',
        'ISSUE_COMMENT_DELETE', 'ISSUE_ATTACHMENT', 'ISSUE_ATTACHMENT_DELETE', 'ISSUE_LINK', 'ISSUE_CLONE', 'ISSUE_MOVE', 'ISSUE_BULK_UPDATE'
      ],
    },
    {
      name: 'Project Manager',
      description: 'Manages sprints, backlogs, priorities, issue scheduling, and workload execution.',
      is_system: 1,
      permissions: [
        'PROJECT_VIEW', 'PROJECT_UPDATE', 'BOARD_VIEW', 'BOARD_UPDATE', 'BOARD_MANAGE',
        'SPRINT_VIEW', 'SPRINT_CREATE', 'SPRINT_UPDATE', 'SPRINT_START', 'SPRINT_COMPLETE', 'SPRINT_MANAGE',
        'REPORT_VIEW', 'REPORT_EXPORT', 'DASHBOARD_VIEW', 'DASHBOARD_CREATE',
        'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_ASSIGN', 'ISSUE_COMMENT',
        'ISSUE_ATTACHMENT', 'ISSUE_LINK', 'ISSUE_CLONE', 'ISSUE_MOVE', 'ISSUE_BULK_UPDATE'
      ],
    },
    {
      name: 'Developer',
      description: 'Builds software, creates/updates issues, transitions workflows, comments, and attaches files.',
      is_system: 1,
      permissions: [
        'PROJECT_VIEW', 'BOARD_VIEW', 'SPRINT_VIEW', 'DASHBOARD_VIEW', 'REPORT_VIEW',
        'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_ASSIGN', 'ISSUE_COMMENT',
        'ISSUE_ATTACHMENT', 'ISSUE_ATTACHMENT_DELETE', 'ISSUE_LINK', 'ISSUE_CLONE'
      ],
    },
    {
      name: 'Tester',
      description: 'Performs quality assurance, logs bugs, creates test issues, verifies transitions, and comments.',
      is_system: 1,
      permissions: [
        'PROJECT_VIEW', 'BOARD_VIEW', 'SPRINT_VIEW', 'DASHBOARD_VIEW', 'REPORT_VIEW',
        'ISSUE_CREATE', 'ISSUE_VIEW', 'ISSUE_UPDATE', 'ISSUE_COMMENT', 'ISSUE_ATTACHMENT', 'ISSUE_LINK'
      ],
    },
    {
      name: 'Viewer',
      description: 'Read-only access to projects, issues, dashboards, and reports.',
      is_system: 1,
      permissions: ['PROJECT_VIEW', 'BOARD_VIEW', 'SPRINT_VIEW', 'ISSUE_VIEW', 'DASHBOARD_VIEW', 'REPORT_VIEW'],
    },
    {
      name: 'Guest',
      description: 'Restricted guest access to specific shared issues and comments.',
      is_system: 1,
      permissions: ['ISSUE_VIEW', 'ISSUE_COMMENT'],
    },
  ];

  for (const r of defaultRoles) {
    let role = db.prepare('SELECT id FROM roles WHERE workspace_id = ? AND name = ?').get(workspaceId, r.name);
    let roleId;
    if (!role) {
      roleId = randomUUID();
      db.prepare(`
        INSERT INTO roles (id, workspace_id, name, description, is_system)
        VALUES (?, ?, ?, ?, ?)
      `).run(roleId, workspaceId, r.name, r.description, r.is_system);
    } else {
      roleId = role.id;
    }

    // Assign permissions
    const permCodes = r.allPermissions
      ? SYSTEM_PERMISSIONS.map((p) => p.code)
      : r.permissions || [];

    for (const code of permCodes) {
      db.prepare(`
        INSERT OR IGNORE INTO role_permissions (role_id, permission_code)
        VALUES (?, ?)
      `).run(roleId, code);
    }

    // If Company Owner, assign to owner user
    if (r.name === 'Company Owner' && ownerUserId) {
      db.prepare(`
        INSERT OR IGNORE INTO user_roles (id, workspace_id, user_id, role_id)
        VALUES (?, ?, ?, ?)
      `).run(randomUUID(), workspaceId, ownerUserId, roleId);
    }
  }

  // 2. Default Issue Types
  const defaultIssueTypes = [
    { name: 'Epic', icon: 'zap', color: '#8B5CF6', description: 'A big body of work that can be broken down into stories and tasks' },
    { name: 'Story', icon: 'bookmark', color: '#10B981', description: 'A user requirement or functional enhancement' },
    { name: 'Task', icon: 'check-square', color: '#3B82F6', description: 'A general task that needs to be performed' },
    { name: 'Bug', icon: 'alert-circle', color: '#EF4444', description: 'A problem which impairs or prevents system functions' },
    { name: 'Sub-task', icon: 'list', color: '#6B7280', description: 'A piece of work required to complete another task' },
    { name: 'Improvement', icon: 'trending-up', color: '#F59E0B', description: 'An improvement to an existing feature' },
    { name: 'Change Request', icon: 'file-text', color: '#EC4899', description: 'A formal proposal for system alteration' },
  ];

  for (const it of defaultIssueTypes) {
    const existing = db.prepare('SELECT id FROM issue_types WHERE workspace_id = ? AND name = ?').get(workspaceId, it.name);
    if (!existing) {
      db.prepare(`
        INSERT INTO issue_types (id, workspace_id, name, icon, color, description)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), workspaceId, it.name, it.icon, it.color, it.description);
    }
  }

  // 3. Default Workflow
  const existingWorkflow = db.prepare('SELECT id FROM workflows WHERE workspace_id = ? AND is_default = 1').get(workspaceId);
  if (!existingWorkflow) {
    const workflowId = randomUUID();
    db.prepare(`
      INSERT INTO workflows (id, workspace_id, name, description, is_default)
      VALUES (?, ?, ?, ?, 1)
    `).run(workflowId, workspaceId, 'Standard Software Development Workflow', 'Default enterprise workflow for software development');

    const statuses = [
      { name: 'BACKLOG', category: 'TODO', color: '#94A3B8', position: 0 },
      { name: 'TODO', category: 'TODO', color: '#3B82F6', position: 1 },
      { name: 'IN_PROGRESS', category: 'IN_PROGRESS', color: '#F59E0B', position: 2 },
      { name: 'CODE_REVIEW', category: 'IN_PROGRESS', color: '#8B5CF6', position: 3 },
      { name: 'TESTING', category: 'IN_PROGRESS', color: '#06B6D4', position: 4 },
      { name: 'DONE', category: 'DONE', color: '#10B981', position: 5 },
    ];

    for (const s of statuses) {
      db.prepare(`
        INSERT INTO workflow_statuses (id, workflow_id, name, category, color, position)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), workflowId, s.name, s.category, s.color, s.position);
    }
  }

  // 4. Default Security Policies
  const existingSec = db.prepare('SELECT workspace_id FROM security_policies WHERE workspace_id = ?').get(workspaceId);
  if (!existingSec) {
    db.prepare(`
      INSERT INTO security_policies (workspace_id, min_password_length, require_special_char, require_numbers, session_timeout_mins, mfa_required)
      VALUES (?, 8, 1, 1, 1440, 0)
    `).run(workspaceId);
  }

  // 5. Default Subscription
  const existingSub = db.prepare('SELECT id FROM subscriptions WHERE workspace_id = ?').get(workspaceId);
  if (!existingSub) {
    db.prepare(`
      INSERT INTO subscriptions (id, workspace_id, plan, billing_cycle, user_limit, project_limit, storage_limit_gb, status, current_period_end)
      VALUES (?, ?, 'BUSINESS', 'MONTHLY', 100, -1, 500, 'ACTIVE', date('now', '+30 days'))
    `).run(randomUUID(), workspaceId);

    // Add initial invoice
    db.prepare(`
      INSERT INTO invoices (id, workspace_id, invoice_number, amount, currency, status, invoice_date)
      VALUES (?, ?, 'INV-2026-001', 7999.00, 'INR', 'PAID', date('now', '-5 days'))
    `).run(randomUUID(), workspaceId);
  }

  // 6. Default Teams if none exist
  const existingTeamCount = db.prepare('SELECT COUNT(*) as c FROM teams WHERE workspace_id = ?').get(workspaceId);
  if (existingTeamCount.c === 0) {
    const defaultTeams = [
      { name: 'Backend Engineering', desc: 'Core APIs, microservices, databases, and system architecture' },
      { name: 'Frontend & UI/UX', desc: 'Web applications, design systems, client state, and responsive UX' },
      { name: 'QA & Automation', desc: 'Quality assurance, test automation, performance and security testing' },
      { name: 'DevOps & Cloud', desc: 'CI/CD pipelines, containerization, cloud infrastructure, and monitoring' },
      { name: 'Product Management', desc: 'Product roadmaps, feature specifications, and agile sprint planning' },
    ];

    for (const t of defaultTeams) {
      const teamId = randomUUID();
      db.prepare(`
        INSERT INTO teams (id, workspace_id, name, description, lead_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(teamId, workspaceId, t.name, t.desc, ownerUserId);

      if (ownerUserId) {
        db.prepare(`
          INSERT INTO team_members (id, team_id, user_id)
          VALUES (?, ?, ?)
        `).run(randomUUID(), teamId, ownerUserId);
      }
    }
  }

  // 7. Initial Audit Log
  const existingAudit = db.prepare('SELECT id FROM audit_logs WHERE workspace_id = ? LIMIT 1').get(workspaceId);
  if (!existingAudit && ownerUserId) {
    const ownerUser = db.prepare('SELECT name FROM users WHERE id = ?').get(ownerUserId);
    logAudit({
      workspaceId,
      actorId: ownerUserId,
      actorName: ownerUser?.name || 'System Owner',
      action: 'WORKSPACE_INITIALIZED',
      entityType: 'COMPANY',
      entityId: workspaceId,
      details: 'Enterprise workspace and security policies successfully initialized with default roles and permissions.',
    });
  }
}

// Enterprise Audit Logger Helper
export function logAudit({ workspaceId, actorId, actorName, action, entityType, entityId, details, ipAddress = '127.0.0.1' }) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, workspace_id, actor_id, actor_name, action, entity_type, entity_id, details, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      workspaceId,
      actorId || null,
      actorName || 'System',
      action,
      entityType,
      entityId || null,
      typeof details === 'object' ? JSON.stringify(details) : details || '',
      ipAddress
    );
  } catch (e) {
    console.error('[AUDIT_LOG_ERROR]:', e);
  }
}

// User Business Activity Stream Helper
export function logActivity({ workspaceId, projectId = null, taskId = null, userId, action, details = '' }) {
  try {
    db.prepare(`
      INSERT INTO activities (id, workspace_id, project_id, task_id, user_id, action, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      workspaceId,
      projectId || null,
      taskId || null,
      userId,
      action,
      typeof details === 'object' ? JSON.stringify(details) : details || ''
    );
  } catch (e) {
    console.error('[ACTIVITY_LOG_ERROR]:', e);
  }
}

// Notification Trigger Helper
export function createNotification({ workspaceId, userId, title, message, link = '', type = 'INFO' }) {
  try {
    db.prepare(`
      INSERT INTO notifications (id, workspace_id, user_id, title, message, link, type)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), workspaceId, userId, title, message, link, type);
  } catch (e) {
    console.error('[NOTIFICATION_ERROR]:', e);
  }
}

// Automation Execution Runner Helper
export function triggerAutomations({ workspaceId, triggerEvent, context = {} }) {
  try {
    const rules = db.prepare(`
      SELECT * FROM automations WHERE workspace_id = ? AND trigger_event = ? AND is_active = 1
    `).all(workspaceId, triggerEvent);

    for (const rule of rules) {
      // Execute simulated rule action
      db.prepare(`
        UPDATE automations 
        SET execution_count = execution_count + 1, last_run_at = CURRENT_TIMESTAMP 
        WHERE id = ?
      `).run(rule.id);

      db.prepare(`
        INSERT INTO automation_logs (id, automation_id, workspace_id, status, details)
        VALUES (?, ?, ?, 'SUCCESS', ?)
      `).run(randomUUID(), rule.id, workspaceId, `Rule "${rule.name}" triggered on ${triggerEvent}: ${JSON.stringify(context)}`);
    }
  } catch (e) {
    console.error('[AUTOMATION_RUNNER_ERROR]:', e);
  }
}

try {
  initSchema();
} catch (e) {
  // Ignore
}

// Auto-seed default dashboards if not present
try {
  const DEFAULT_DASH_TPLS = [
    {
      name: 'Executive Overview',
      description: 'High-level operational KPIs, project delivery progress, and priority distribution.',
      layout: '2_COLUMN_EQUAL',
      is_default: 1,
      gadgets: [
        { gadget_type: 'PROJECT_PROGRESS', title: 'Project Delivery Progress', column_index: 0, position: 0 },
        { gadget_type: 'PRIORITY_BREAKDOWN', title: 'Priority Distribution', column_index: 1, position: 0 },
        { gadget_type: 'CREATED_VS_RESOLVED', title: 'Created vs Resolved Trend', column_index: 0, position: 1 },
        { gadget_type: 'TYPE_BREAKDOWN', title: 'Issue Types Distribution', column_index: 1, position: 1 },
        { gadget_type: 'TEAM_WORKLOAD', title: 'Team Workload & Capacity', column_index: 0, position: 2 },
        { gadget_type: 'ACTIVITY_STREAM', title: 'Recent Activity Stream', column_index: 1, position: 2 },
      ],
    },
    {
      name: 'Sprint Delivery & Agile Health',
      description: 'Active sprint execution, burndown velocity, and team member workload.',
      layout: '2_COLUMN_EQUAL',
      is_default: 0,
      gadgets: [
        { gadget_type: 'ACTIVE_SPRINTS', title: 'Active Sprints Health', column_index: 0, position: 0 },
        { gadget_type: 'ASSIGNED_TO_ME', title: 'My Work Queue', column_index: 1, position: 0 },
        { gadget_type: 'TEAM_WORKLOAD', title: 'Sprint Workload by Assignee', column_index: 0, position: 1 },
        { gadget_type: 'TWO_DIMENSIONAL', title: 'Assignee vs Status Matrix', column_index: 1, position: 1 },
      ],
    },
    {
      name: 'Quality & Incident Watch',
      description: 'Critical blocking issues, overdue tasks, and incident SLA tracking.',
      layout: '2_COLUMN_EQUAL',
      is_default: 0,
      gadgets: [
        { gadget_type: 'OVERDUE_WATCHLIST', title: 'Overdue Work Items Watchlist', column_index: 0, position: 0 },
        { gadget_type: 'PRIORITY_BREAKDOWN', title: 'Urgent & Critical Escalations', column_index: 1, position: 0 },
        { gadget_type: 'PROJECT_PROGRESS', title: 'Project Health Breakdown', column_index: 0, position: 1 },
        { gadget_type: 'ACTIVITY_STREAM', title: 'Incident & Issue Audit Trail', column_index: 1, position: 1 },
      ],
    },
  ];

  if (db && typeof db.prepare === 'function') {
    const wsList = db.prepare('SELECT id, user_id FROM workspaces').all() || [];
    for (const ws of wsList) {
      if (!ws || !ws.id) continue;
      const row = db.prepare('SELECT COUNT(*) as c FROM dashboards WHERE workspace_id = ?').get(ws.id);
      const existing = row?.c ?? 0;
      if (existing === 0) {
        for (const tpl of DEFAULT_DASH_TPLS) {
          const dashId = randomUUID();
          db.prepare(`
            INSERT INTO dashboards (id, workspace_id, name, description, layout, is_default, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(dashId, ws.id, tpl.name, tpl.description, tpl.layout, tpl.is_default, ws.user_id);

          for (const g of tpl.gadgets) {
            db.prepare(`
              INSERT INTO dashboard_gadgets (id, dashboard_id, workspace_id, gadget_type, title, column_index, position, settings)
              VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
            `).run(randomUUID(), dashId, ws.id, g.gadget_type, g.title, g.column_index, g.position);
          }
        }
      }
    }
  }
} catch (e) {
  // Ignore startup seed errors
}


export function formatDoc(row) {
  if (!row) return null;
  const doc = { ...row };
  doc.$id = row.id;
  doc.$createdAt = row.created_at;
  doc.$updatedAt = row.updated_at;
  if (row.user_id !== undefined) doc.userId = row.user_id;
  if (row.workspace_id !== undefined) doc.workspaceId = row.workspace_id;
  if (row.project_id !== undefined) doc.projectId = row.project_id;
  if (row.assignee_id !== undefined) doc.assigneeId = row.assignee_id;
  if (row.image_id !== undefined) doc.imageId = row.image_id;
  if (row.image_url !== undefined) doc.imageUrl = row.image_url;
  if (row.invite_code !== undefined) doc.inviteCode = row.invite_code;
  if (row.due_date !== undefined) doc.dueDate = row.due_date;
  if (row.start_date !== undefined) doc.startDate = row.start_date;
  if (row.end_date !== undefined) doc.endDate = row.end_date;
  if (row.sprint_id !== undefined) doc.sprintId = row.sprint_id;
  return doc;
}
