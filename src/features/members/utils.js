import { db, formatDoc } from '../../db.js';

export const getMember = async ({ workspaceId, userId }) => {
  const member = db.prepare(`
    SELECT * FROM members WHERE workspace_id = ? AND user_id = ?
  `).get(workspaceId, userId);

  return formatDoc(member);
};
