import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { questRepository, sessionRepository } from '@bike4mind/database';
import { ApiKeyScope, redactPromptMetaForViewer, toToolPayloads } from '@bike4mind/common';
import { toGeneratedFiles } from '@server/utils/generatedFiles';
import { resolveQuestTimeoutRecovery } from '@server/chatCompletion/questTimeoutRecovery';
import { isSessionOwnedByUser } from '@server/utils/sessionOwnership';
import type { Request } from 'express';

// Reading a quest is the documented poll step after POST /api/chat, so an AI
// scope (ai:chat / ai:generate) grants it as well as notebooks:read - otherwise
// a least-privilege chat key 403s on its own reply. OR / "any of" semantics.
const handler = baseApi({
  requiredScopes: [ApiKeyScope.READ_NOTEBOOKS, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  // Quest status is the poll step of the async generation pipeline; don't let
  // polling one job to completion burn the daily quota that meters submissions.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req: Request<{}, {}, {}, { id: string }>, res) => {
  const { id: questId } = req.query;
  const userId = req.user?.id;

  if (!questId) {
    throw new BadRequestError('Quest ID is required');
  }

  const quest = await questRepository.findById(questId);

  if (!quest) {
    throw new NotFoundError('Quest not found');
  }

  const session = await sessionRepository.findById(quest.sessionId);
  if (!session) {
    throw new NotFoundError('Quest not found');
  }

  const userHasAccess = isSessionOwnedByUser(session, userId);

  if (!userHasAccess) {
    throw new NotFoundError('Quest not found');
  }

  // A share grant authorizes reading the conversation, not re-reading whatever the owner's
  // tools touched on the owner's behalf - see redactPromptMetaForViewer. It also gates the
  // recovery write below.
  const isOwner = session.userId === userId;

  // Recover a stuck quest on read so API clients (CLI, MCP, automated harnesses) that poll
  // this endpoint get a terminal status without needing the browser-only check-timeout POST.
  // See resolveQuestTimeoutRecovery for the liveness-based decision.
  //
  // Owner-only: a sharee's read must not stamp a terminal status onto someone else's quest.
  // The sweep cron is the backstop for a quest only sharees ever poll, so nothing stays stuck.
  const recovery = isOwner ? resolveQuestTimeoutRecovery(quest, Date.now()) : null;
  if (recovery) {
    try {
      // Conditional on the quest still being unfinished so a real answer that landed between
      // the read above and this write keeps it. Best-effort: writes fail for reasons reads do
      // not (a primary stepdown, a write-concern timeout), and letting that turn a GET that can
      // still answer into a 500 is strictly worse than the pre-recovery behaviour. Recovery is
      // idempotent, so the next poll or the next sweep redoes it.
      const applied = await questRepository.settleIfUnfinished(quest.id, recovery);
      if (applied) {
        // `updatedAt` is maintained by mongoose timestamps on that write, so report the write
        // rather than the stale value the read returned.
        Object.assign(quest, recovery, { updatedAt: new Date() });
      }
    } catch (err) {
      req.logger.warn('Timeout recovery write failed; returning quest as-is', { questId: quest.id, err });
    }
  }

  // `quest.images` holds bare generated-file basenames (e.g. `<uuid>.png`, a `.mp3` from
  // music_generation, or a `.xlsx` from excel_generation - not everything here is an image).
  // Programmatic pollers shouldn't have to know the CDN path convention, so we resolve each into
  // a typed descriptor with a ready-to-use URL server-side (the single source of truth). `images`
  // (raw basenames) is kept for parity with the WebSocket payload; `files[].isImage`/`isAudio`
  // let a caller pick out renderable media.
  const images = quest.images ?? [];
  const files = toGeneratedFiles(images);

  const promptMeta = redactPromptMetaForViewer(quest.promptMeta, isOwner);

  // Structured tool output for this turn. This is the poll step for BOTH the async chat path and
  // an agent run persisted as a quest, so it is the one place a programmatic caller can read what
  // a tool actually produced - `reply`/`replies` carry only the model's prose. Not viewer-redacted:
  // these same payloads already reach every session participant's client (SessionMiddle dispatches
  // them off loaded quests), so a share holder gains nothing new here.
  const toolPayloads = toToolPayloads(quest.uiSideEffects);

  return res.json({
    id: quest.id,
    status: quest.status,
    // A recovered timeout is `status: 'done'` carrying an error message, so a headless client
    // needs `type` to machine-distinguish it from a genuine success.
    type: quest.type,
    sessionId: quest.sessionId,
    reply: quest.reply,
    replies: quest.replies,
    images,
    files,
    toolPayloads,
    createdAt: quest.createdAt,
    updatedAt: quest.updatedAt,
    promptMeta,
    // The attachment report, both halves. `attachmentNotices` explains what did not arrive;
    // `attachmentDelivery` is the affirmative count, and is the only field that separates "the
    // caller attached nothing" from "the caller attached files and none arrived" - the exact
    // ambiguity #1576 was filed about. Neither is viewer-redacted: both describe the caller's own
    // submission and already reach every participant's client off the loaded quest.
    // `promptMeta.context.tokensBySource.fabFiles` is NOT a substitute; it folds the turn's own
    // attachments in with message and system files under one token count, so it cannot tell those
    // two states apart.
    //
    // Keep the bare word "session" followed by a comma or brace out of this literal:
    // server/__tests__/sessionRedactionGuard.test.ts regex-scans the whole res.json({...}) span,
    // comments included, and reads that shape as a raw session document being serialized.
    attachmentNotices: quest.attachmentNotices,
    attachmentDelivery: quest.attachmentDelivery,
    executionTracking: quest.promptMeta?.executionTracking,
  });
});

export default handler;
