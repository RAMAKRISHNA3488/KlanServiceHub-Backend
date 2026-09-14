import { randomUUID } from 'node:crypto';
import { db, formatDoc } from '../../db.js';

export const getMember = async ({ workspaceId, userId }) => {
  if (!workspaceId || !userId) return null;

  let member = db.prepare(`
    SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId);

  if (!member) {
    const ws = db.prepare('SELECT user_id FROM workspaces WHERE id = ?').get(workspaceId);
    if (ws && ws.user_id === userId) {
      const memberId = randomUUID();
      try {
        db.prepare("INSERT INTO members (id, workspace_id, user_id, role, status) VALUES (?, ?, ?, 'ADMIN', 'ACTIVE')").run(memberId, workspaceId, userId);
        member = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      } catch (e) {
        member = { id: memberId, workspace_id: workspaceId, user_id: userId, role: 'ADMIN', status: 'ACTIVE' };
      }
    }
  }

  return formatDoc(member);
};
