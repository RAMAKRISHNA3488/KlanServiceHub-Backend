import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { MemberRole } from '../types.js';
import { getMember } from '../utils.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc } from '../../../db.js';

const app = new Hono()
  .get(
    '/',
    sessionMiddleware,
    zValidator(
      'query',
      z.object({
        workspaceId: z.string(),
      }),
    ),
    async (ctx) => {
      const user = ctx.get('user');
      const { workspaceId } = ctx.req.valid('query');

      const member = await getMember({
        workspaceId,
        userId: user.$id,
      });

      if (!member) {
        return ctx.json({ error: 'Unauthorized.' }, 401);
      }

      const rows = db.prepare(`
        SELECT m.*, u.name, u.email 
        FROM members m 
        JOIN users u ON m.user_id = u.id 
        WHERE m.workspace_id = ?
      `).all(workspaceId);

      const documents = rows.map(formatDoc);

      return ctx.json({
        data: {
          documents,
          total: documents.length,
        },
      });
    },
  )
  .delete('/:memberId', sessionMiddleware, async (ctx) => {
    const { memberId } = ctx.req.param();
    const user = ctx.get('user');

    const memberToDelete = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

    if (!memberToDelete) {
      return ctx.json({ error: 'Member not found.' }, 404);
    }

    const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(memberToDelete.workspace_id);

    if (memberCount.count <= 1) {
      return ctx.json({ error: 'Cannot delete the only member.' }, 400);
    }

    const currentMember = await getMember({
      workspaceId: memberToDelete.workspace_id,
      userId: user.$id,
    });

    if (!currentMember) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    if (currentMember.$id !== memberToDelete.id && currentMember.role !== MemberRole.ADMIN) {
      return ctx.json({ error: 'Unauthorized.' }, 401);
    }

    db.prepare('DELETE FROM members WHERE id = ?').run(memberId);

    return ctx.json({ data: { $id: memberToDelete.id, workspaceId: memberToDelete.workspace_id } });
  })
  .patch(
    '/:memberId',
    sessionMiddleware,
    zValidator(
      'json',
      z.object({
        role: z.nativeEnum(MemberRole),
      }),
    ),
    async (ctx) => {
      const { memberId } = ctx.req.param();
      const { role } = ctx.req.valid('json');
      const user = ctx.get('user');

      const memberToUpdate = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);

      if (!memberToUpdate) {
        return ctx.json({ error: 'Member not found.' }, 404);
      }

      const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(memberToUpdate.workspace_id);

      if (memberCount.count <= 1) {
        return ctx.json({ error: 'Cannot downgrade the only member.' }, 400);
      }

      const currentMember = await getMember({
        workspaceId: memberToUpdate.workspace_id,
        userId: user.$id,
      });

      if (!currentMember || currentMember.role !== MemberRole.ADMIN) {
        return ctx.json({ error: 'Unauthorized.' }, 401);
      }

      db.prepare('UPDATE members SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, memberId);

      return ctx.json({ data: { $id: memberToUpdate.id, workspaceId: memberToUpdate.workspace_id } });
    },
  );

export default app;
