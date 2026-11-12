import { z } from 'zod';
import { adminApi } from '@server/middlewares/adminApi';
import { visibleDlqSuggestion } from '@server/admin/dlq/triage';
import { adminAiSuggestionRepository, withTransaction } from '@bike4mind/database';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordAdminActionFromRequest } from '@bike4mind/server-utils/utils/adminAudit';

const querySchema = z.object({ queue: z.string().min(1), message: z.string().min(1) });
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read', POST: 'settings:manage' } })
  .get(async (req, res) => {
    const query = querySchema.parse(req.query);
    return res.json({ suggestion: await visibleDlqSuggestion(query.queue, query.message) });
  })
  .post(async (req, res) => {
    const body = z
      .object({
        queue: z.string().min(1),
        message: z.string().min(1),
        suggestionId: z.string().regex(/^[0-9a-f]{24}$/),
        decision: z.literal('dismiss'),
      })
      .parse(req.body);
    const suggestion = await visibleDlqSuggestion(body.queue, body.message);
    if (!suggestion || suggestion.id !== body.suggestionId || !req.user)
      throw new BadRequestError('Suggestion is unavailable');
    const decided = await withTransaction(async () => {
      const decided = await adminAiSuggestionRepository.transition(suggestion.id, ['pending'], 'dismissed', {
        decidedBy: { userId: req.user.id, name: req.user.name || req.user.username },
      });
      if (!decided) throw new BadRequestError('Suggestion has already been decided');
      await recordAdminActionFromRequest(req, {
        action: 'ops.dlq.triage.dismissed',
        target: { kind: 'system', id: body.queue, displayName: 'DLQ triage' },
        summary: 'dismissed a dead-letter recommendation',
        details: { aiSuggestionId: suggestion.id, queueLabel: body.queue, messageId: body.message },
      });
      return decided;
    });
    return res.json({ suggestion: decided });
  });

export const config = { api: { externalResolver: true } };
export default handler;
