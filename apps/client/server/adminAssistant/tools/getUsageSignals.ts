import { z } from 'zod';
import { userUsagePatternSignalsRepository } from '@bike4mind/database';
import { defineAdminTool } from '../defineAdminTool';

const inputSchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/i, 'userId must be a 24-character hex ObjectId'),
});

export const getUsageSignalsTool = defineAdminTool({
  name: 'admin_get_usage_signals',
  description:
    'Read the stored usage pattern signals for one user: the risk score, whether it needs review, and each signal with its value, weight and explanation.',
  input: inputSchema,
  run: async ({ userId }) => {
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
