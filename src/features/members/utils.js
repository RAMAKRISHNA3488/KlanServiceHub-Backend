import { db, formatDoc, getD1Database } from '../../db.js';

export const getMember = async ({ workspaceId, userId }) => {
  const d1 = getD1Database();
  if (d1) {
    try {
      const member = await d1.prepare(`
        SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
      `).bind(workspaceId, userId).first();
      if (member) return formatDoc(member);
    } catch (e) {
      console.error('[D1_GET_MEMBER_ERROR]:', e);
    }
  }

  const member = db.prepare(`
    SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId);

  return formatDoc(member);
};
