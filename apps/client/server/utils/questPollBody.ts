import {
  PolledFallbackInfoSchema,
  redactPromptMetaForViewer,
  toToolPayloads,
  type IChatHistoryItemDocument,
} from '@bike4mind/common';
import { toGeneratedFiles } from '@server/utils/generatedFiles';

/**
 * The `GET /api/v1/quests/{id}` body. Also the body of a generation completion callback
 * (queueHandlers/generationCallback.ts), which is documented as "the same body the poll returns",
 * so a field added here reaches both.
 *
 * `isOwner` gates promptMeta redaction: a share grant authorizes reading the conversation, not
 * re-reading whatever the owner's tools touched (see redactPromptMetaForViewer).
 */
export function toQuestPollBody(quest: IChatHistoryItemDocument, { isOwner }: { isOwner: boolean }) {
  // `quest.images` holds bare generated-file basenames (e.g. `<uuid>.png`, a `.mp3` from
  // music_generation, or a `.xlsx` from excel_generation - not everything here is an image).
  // Programmatic pollers shouldn't have to know the CDN path convention, so we resolve each into
  // a typed descriptor with a ready-to-use URL server-side (the single source of truth). `images`
  // (raw basenames) is kept for parity with the WebSocket payload; `files[].isImage`/`isAudio`/`isVideo`
  // let a caller pick out renderable media.
  const images = quest.images ?? [];
  // Rendered videos are basenames under the same `generated/` prefix (PromptReplies builds the
  // same URL), so they resolve through the same helper. Without them a video callback or poll
  // settles `done` with nothing to fetch.
  const videos = quest.videos ?? [];
  const files = toGeneratedFiles([...images, ...videos]);

  const promptMeta = redactPromptMetaForViewer(quest.promptMeta, isOwner);

  // Structured tool output for this turn. This is the poll step for BOTH the async chat path and
  // an agent run persisted as a quest, so it is the one place a programmatic caller can read what
  // a tool actually produced - `reply`/`replies` carry only the model's prose. Not viewer-redacted:
  // these same payloads already reach every session participant's client (SessionMiddle dispatches
  // them off loaded quests), so a share holder gains nothing new here.
  const toolPayloads = toToolPayloads(quest.uiSideEffects);

  // safeParse: the model tolerates partial records, and one malformed fallbackInfo must not make
  // the whole quest unreadable.
  // Gated on `type` like errorCode: a timed-out or abandoned run is settled as an error by recovery
  // paths that never touch fallbackInfo, and a failed turn must not claim a model answered it.
  const fallbackInfo =
    quest.fallbackInfo && quest.type !== 'error'
      ? PolledFallbackInfoSchema.safeParse(quest.fallbackInfo).data
      : undefined;

  return {
    id: quest.id,
    status: quest.status,
    // A recovered timeout is `status: 'done'` carrying an error message, so a headless client
    // needs `type` to machine-distinguish it from a genuine success.
    type: quest.type,
    // Why the turn failed, for the `type: 'error'` cases that have one (credit exhaustion
    // today). The WebSocket quest payload has always carried this; without it here a polling
    // caller can only pattern-match the failure prose in `reply`. Modelled on the chat
    // contract as sendChatMessage200PollResult.
    //
    // Gated on `type` (mirrors chat.ts): the field is persisted on the quest, and while the
    // retry path now clears it (ChatCompletionInvoke), rows written before that fix still
    // carry a code from an attempt that has since succeeded. Reading it ungated resurfaces one.
    ...(quest.type === 'error' && { errorCode: quest.errorCode }),
    sessionId: quest.sessionId,
    reply: quest.reply,
    replies: quest.replies,
    // Which model actually answered, when the requested one failed over.
    fallbackInfo,
    images,
    videos,
    files,
    toolPayloads,
    createdAt: quest.createdAt,
    updatedAt: quest.updatedAt,
    promptMeta,
    // The attachment report, both halves. `attachmentNotices` explains what did not arrive;
    // `attachmentDelivery` is the affirmative count, and is the only field that separates "the
    // caller attached nothing" from "the caller attached files and none arrived" - the exact
    // ambiguity #1576 was filed about. Neither is viewer-redacted, and that is a parity decision
    // rather than an omission: GET /api/sessions/[id]/chat (getMessagesFromSession) already spreads
    // the whole quest document to everyone `findAccessibleById` admits, share holders included, and
    // it redacts only promptMeta. Redacting here alone would hide these two fields from a sharee who
    // reads them off the very next call the SPA makes.
    // `promptMeta.context.tokensBySource.fabFiles` is NOT a substitute; it folds the turn's own
    // attachments in with message and system files under one token count, so it cannot tell those
    // two states apart.
    attachmentNotices: quest.attachmentNotices,
    attachmentDelivery: quest.attachmentDelivery,
    executionTracking: quest.promptMeta?.executionTracking,
  };
}
