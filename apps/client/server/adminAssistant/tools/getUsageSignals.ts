import { userUsagePatternSignalsRepository } from '@bike4mind/database';
import { defineAdminTool } from '../defineAdminTool';
import { resolveAdminUserRef } from '../resolveAdminUserRef';
import { AdminUserRefSchema } from '../schemas';

export const getUsageSignalsTool = defineAdminTool({
  name: 'admin_get_usage_signals',
  description:
    'Read the stored usage pattern signals for one user: the risk score, whether it needs review, and each signal with its value, weight and explanation.',
  input: AdminUserRefSchema,
  run: async ref => {
    const user = await resolveAdminUserRef(ref);
    if (!user) return { ok: false, error: 'not_found', message: 'No user matches that id or email.' };
    const userId = user.id;
    const stored = await userUsagePatternSignalsRepository.findByUserId(userId);
    if (!stored) {
      return {
        ok: false,
        error: 'not_found',
        message: 'No usage pattern signals computed for this user in the last 30 days',
      };
    }

    return {
      ok: true,
      data: {
        userId: stored.userId,
        score: stored.score,
        needsReview: stored.needsReview,
        skipped: stored.skipped ?? null,
        computedAt: new Date(stored.computedAt).toISOString(),
        signals: stored.signals.map(({ id, value, triggered, weight, explanation }) => ({
          id,
          value,
          triggered,
          weight,
          explanation,
        })),
      },
    };
  },
});
