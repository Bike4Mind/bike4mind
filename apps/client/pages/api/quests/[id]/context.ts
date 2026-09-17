import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { redactPromptMetaForViewer } from '@bike4mind/common';
import { buildContextBreakdown } from '@bike4mind/services';
import type { Request } from 'express';

/**
 * The user's own /context view for one of their quests: which system-prompt layers, tools, files
 * and history made up the turn, and what was left of the window.
 *
 * Owner-only, and stricter than GET /api/quests/[id]: a share grant authorizes reading the
 * conversation, not auditing how the owner's context was assembled. Non-owners get the same 404 a
 * stranger gets, so the route cannot be used to probe which quest ids exist.
 */
// Browser-only self-view: no api-contract backs this route, so no API key should reach it.
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req: Request<{}, {}, {}, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  // Their own preference, not the global EnableContextTelemetry toggle: that one governs whether a
  // pseudonymized row is stored for our analytics, while everything read below is written on every
  // quest regardless. A user who turned telemetry off still gets an explanation rather than a 404.
  if ((req.user?.preferences?.contextTelemetryLevel ?? 'basic') === 'none') {
    throw new ForbiddenError(
      'Context breakdowns are off while your telemetry level is None. Change it in Profile > Settings.'
    );
  }

  const quest = await questRepository.findById(questId);
  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  const session = await sessionRepository.findById(quest.sessionId);
  const isOwner = !!userId && session?.userId === userId;
  if (!isOwner) {
    throw new NotFoundError('Quest not found');
  }

  // No-op for an owner. If this gate is ever widened, note the denylist would NOT cover this
  // response - buildContextBreakdown never emits the two fields it strips.
  const promptMeta = redactPromptMetaForViewer(quest.promptMeta, isOwner);

  return res.json(buildContextBreakdown(promptMeta, { questId: quest.id }));
});

export default handler;
