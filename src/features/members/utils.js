import { db, formatDoc, getD1Database } from '../../db.js';

export const getMember = async ({ workspaceId, userId, d1 = null }) => {
  if (!workspaceId || !userId) return null;

  const dbInstance = d1 || getD1Database();

  // 1. Check in Cloudflare D1
  if (dbInstance) {
    try {
      const member = await dbInstance.prepare(`
        SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
      `).bind(workspaceId, userId).first();
      if (member) return formatDoc(member);

      // Check if user is the workspace creator/owner
      const ws = await dbInstance.prepare(`
        SELECT id, user_id FROM workspaces WHERE id = ?
      `).bind(workspaceId).first();

      if (ws && String(ws.user_id) === String(userId)) {
        // User is the workspace owner! Auto-repair and return synthetic ADMIN member
        const autoMemberId = `mem-${String(userId).slice(0, 8)}-${String(workspaceId).slice(0, 8)}`;
        try {
          await dbInstance.prepare(`
            INSERT OR IGNORE INTO members (id, workspace_id, user_id, role, status)
            VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')
          `).bind(autoMemberId, workspaceId, userId).run();
        } catch (_) {}

        return formatDoc({
          id: autoMemberId,
          workspace_id: workspaceId,
          user_id: userId,
          role: 'ADMIN',
          status: 'ACTIVE',
        });
      }
    } catch (e) {
      console.error('[D1_GET_MEMBER_ERROR]:', e);
    }
  }

  // 2. Fallback to SQLite (local / Node test environment)
  try {
    const member = db.prepare(`
      SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
    `).get(workspaceId, userId);

    if (member) return formatDoc(member);

    const ws = db.prepare(`
      SELECT id, user_id FROM workspaces WHERE id = ?
    `).get(workspaceId);

    if (ws && String(ws.user_id) === String(userId)) {
      return formatDoc({
        id: `mem-${String(userId).slice(0, 8)}-${String(workspaceId).slice(0, 8)}`,
        workspace_id: workspaceId,
        user_id: userId,
        role: 'ADMIN',
        status: 'ACTIVE',
      });
    }
  } catch (e) {
    // db might not be initialized in worker environment
  }

  return null;
};

