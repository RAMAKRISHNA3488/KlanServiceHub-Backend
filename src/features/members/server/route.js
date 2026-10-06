import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { MemberRole } from '../types.js';
import { getMember } from '../utils.js';
import { sessionMiddleware } from '../../../lib/session-middleware.js';
import { db, formatDoc, getD1Database } from '../../../db.js';

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

      const d1 = ctx.env?.DB || getD1Database();
      let rows = [];
      if (d1) {
        try {
          const res = await d1.prepare(`
            SELECT m.*, u.name, u.email 
            FROM members m 
            JOIN users u ON m.user_id = u.id 
            WHERE m.workspace_id = ?
          `).bind(workspaceId).all();
          rows = res.results || [];
        } catch (e) {
          console.error('[D1_MEMBERS_GET_ERROR]:', e);
        }
      }

      if (rows.length === 0) {
        rows = db.prepare(`
          SELECT m.*, u.name, u.email 
          FROM members m 
          JOIN users u ON m.user_id = u.id 
          WHERE m.workspace_id = ?
        `).all(workspaceId);
      }

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
    const d1 = ctx.env?.DB || getD1Database();

    let memberToDelete = null;
    if (d1) {
      try {
        memberToDelete = await d1.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first();
      } catch (e) {}
    }
    if (!memberToDelete) {
      memberToDelete = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
    }

    if (!memberToDelete) {
      return ctx.json({ error: 'Member not found.' }, 404);
    }

    let memberCountNum = 1;
    if (d1) {
      try {
        const mc = await d1.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').bind(memberToDelete.workspace_id).first();
        if (mc) memberCountNum = mc.count;
      } catch (e) {}
    } else {
      const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(memberToDelete.workspace_id);
      if (memberCount) memberCountNum = memberCount.count;
    }

    if (memberCountNum <= 1) {
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

    if (d1) {
      try {
        await d1.prepare('DELETE FROM members WHERE id = ?').bind(memberId).run();
      } catch (e) {}
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
      const d1 = ctx.env?.DB || getD1Database();

      let memberToUpdate = null;
      if (d1) {
        try {
          memberToUpdate = await d1.prepare('SELECT * FROM members WHERE id = ?').bind(memberId).first();
        } catch (e) {}
      }
      if (!memberToUpdate) {
        memberToUpdate = db.prepare('SELECT * FROM members WHERE id = ?').get(memberId);
      }

      if (!memberToUpdate) {
        return ctx.json({ error: 'Member not found.' }, 404);
      }

      let memberCountNum = 1;
      if (d1) {
        try {
          const mc = await d1.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').bind(memberToUpdate.workspace_id).first();
          if (mc) memberCountNum = mc.count;
        } catch (e) {}
      } else {
        const memberCount = db.prepare('SELECT COUNT(*) as count FROM members WHERE workspace_id = ?').get(memberToUpdate.workspace_id);
        if (memberCount) memberCountNum = memberCount.count;
      }

      if (memberCountNum <= 1) {
        return ctx.json({ error: 'Cannot downgrade the only member.' }, 400);
      }

      const currentMember = await getMember({
        workspaceId: memberToUpdate.workspace_id,
        userId: user.$id,
      });

      if (!currentMember || currentMember.role !== MemberRole.ADMIN) {
        return ctx.json({ error: 'Unauthorized.' }, 401);
      }

      if (d1) {
        try {
          await d1.prepare('UPDATE members SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(role, memberId).run();
        } catch (e) {}
      }
      db.prepare('UPDATE members SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(role, memberId);

      return ctx.json({ data: { $id: memberToUpdate.id, workspaceId: memberToUpdate.workspace_id } });
    },
  );

export default app;
