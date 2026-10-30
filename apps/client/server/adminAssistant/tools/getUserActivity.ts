import { z } from 'zod';
import { listUserActivity } from '../../utils/userActivity';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefFields, withExactlyOneUserRef } from '../schemas';

const GetUserActivityInput = withExactlyOneUserRef(
  AdminUserRefFields.extend({
    limit: z.number().int().min(1).max(25).default(15).describe('Maximum entries to return (1-25).'),
  })
);

export const getUserActivityTool = defineAdminTool({
  name: 'admin_get_user_activity',
  description:
    'Read the most recent admin actions taken on a user (credit grants, account changes), newest first. Security events are not included.',
  input: GetUserActivityInput,
  run: async ({ userId, email, limit }) => {
    const user = await resolveAdminUserRef({ userId, email });
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };

    // includeSecurity stays false: those rows carry IPs and user agents.
    const { entries, nextCursor } = await listUserActivity(
      { id: user.id, name: user.name, email: user.email ?? undefined, isAdmin: user.isAdmin },
      { direction: 'target', includeSecurity: false, limit }
    );

    return {
      ok: true,
      data: {
        truncated: nextCursor !== null,
        entries: entries.map(entry => ({
          at: entry.occurredAt.toISOString(),
          action: entry.action,
          ...(entry.actor.name ? { actorName: entry.actor.name } : {}),
          summary: entry.summary,
        })),
      },
    };
  },
});
