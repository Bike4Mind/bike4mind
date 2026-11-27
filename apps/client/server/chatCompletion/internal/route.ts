import { FlaggedContentError, isExpectedCompletionError } from '@bike4mind/utils';
import { timingSafeEqual } from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { IncomingMessage } from 'http';
import { Resource } from 'sst';
import { isUnconfiguredSecret, stripChoicesFromReplies, visibleReplyText } from '@bike4mind/common';
import { questRepository } from '@bike4mind/database';
import { QuestStartBodySchema } from '@bike4mind/services/llm';
import { Logger, describeErrorCause } from '@bike4mind/observability';
import { processQuest } from '@server/queueHandlers/questProcessor';
import {
  QUEST_DISPATCH_SIGNATURE_HEADER,
  QUEST_DISPATCH_TIMESTAMP_HEADER,
  verifyQuestDispatch,
} from '@server/utils/questDispatchSignature';
import { emitProcessingFailed, type ProcessingFailureSurface } from '../processingFailedMetric';

/**
 * Internal `/process` surface of the always-on ChatCompletion.
 *
 * Called only by the frontend Lambda (`/api/ai/llm`, `/api/chat`): it creates the quest, POSTs
 * the QuestStartBody here, and gets a 202 back in ~milliseconds; we process the quest in-process
 * (the container outlives the request, unlike a Lambda) and stream results over WebSocket.
 *
 * Not routed through CloudFront - reachable only on the ALB directly - and guarded by the
 * shared-secret bearer (`authorize`) plus a per-dispatch HMAC over the quest, user and session ids
 * (`hasValidDispatchSignature`) as defense-in-depth. Contrast with the external
 * `/api/ai/v1/completions` route, which is public and uses its own user auth (API key / JWT).
 */

/**
 * Last-resort reply for a quest whose processing threw before anything specific was persisted.
 * Only ever written when `settleIfUnfinished` finds the quest still unfinished - see the catch in
 * `registerInternalRoutes`.
 */
export const GENERIC_PROCESSING_FAILURE_REPLY = 'Something went wrong while processing your request. Please try again.';

/**
 * The failure text as its own slot after whatever already streamed, with `reply` rebuilt from the
 * slots - the same shape as setErrorReply in ChatCompletionProcess. Writing only `reply` would lose
 * the failure from the poll body, which derives `reply` from visible slots when there are any
 * (questReplyText in @bike4mind/common).
 */
export function processingFailureReply(streamed: string[] | undefined): { reply: string; replies: string[] } {
  const visiblePartial = stripChoicesFromReplies(streamed ?? [])
    .replies.map(slot => visibleReplyText(slot))
    .filter(text => text.length > 0);
  const replies = [...visiblePartial, GENERIC_PROCESSING_FAILURE_REPLY];
  return { replies, reply: replies.join('') };
}

/**
 * After processQuest throws: log it at the level its class deserves, then settle the quest so it
 * does not stay 'running' forever. Shared by `/process` and the session turns route (turnsRoute.ts),
 * which runs the quest in-process the same way.
 */
export async function handleQuestProcessingFailure(
  err: unknown,
  {
    questId,
    logger,
    track,
    surface,
  }: { questId: string; logger: Logger; track: (p: Promise<void>) => void; surface: ProcessingFailureSurface }
): Promise<void> {
  const errorMessage = err instanceof Error ? err.message : String(err);
  if (err instanceof FlaggedContentError) {
    // A moderation refusal is an expected user outcome, already logged once at warn by the
    // moderation service (promptModeration in @bike4mind/utils); logging it again here would page.
  } else if (isExpectedCompletionError(err)) {
    logger.warn('Quest processing ended with an expected provider error', { error: errorMessage });
  } else {
    // `error`/`errorCause` stay flat strings for alert sinks that print each field with `${value}`;
    // `err` carries the stack and the full cause chain into the structured log.
    logger.error('Quest processing failed', { error: errorMessage, errorCause: describeErrorCause(err), err });
    track(emitProcessingFailed(surface, err));
  }

  // Surface the failure to the client instead of leaving the quest 'running' forever - but only
  // when nothing terminal was written yet. ChatCompletionProcess persists the provider's own
  // message (`quest.reply = err.message`) and marks the quest terminal before it rethrows, so an
  // unconditional write here replaces a specific, actionable diagnostic with this generic one.
  try {
    // The processor has already thrown, so nothing streams into the slots between this read
    // and the guarded write below.
    const streamed = (await questRepository.findById(questId))?.replies;
    const settled = await questRepository.settleIfUnfinished(questId, {
      status: 'stopped',
      type: 'error',
      ...processingFailureReply(streamed),
    });
    if (!settled) {
      logger.info('Quest already settled by the processor; kept its own error reply', { questId });
    }
  } catch (updateErr) {
    logger.error('Failed to mark quest stopped after processing error', {
      error: updateErr instanceof Error ? updateErr.message : String(updateErr),
      errorCause: describeErrorCause(updateErr),
      err: updateErr,
    });
  }
}

/**
 * Shared-secret bearer check. Both the frontend Lambda and this service link
 * CHAT_COMPLETION_INTERNAL_SECRET (a dedicated internal-dispatch secret, NOT the AES
 * SECRET_ENCRYPTION_KEY), so the caller proves it's the frontend (not arbitrary internet
 * traffic that can reach the public ALB) by presenting it. Must match dispatchQuest.ts.
 */
export function authorize(req: Request): boolean {
  const provided = req.headers.authorization;
  if (typeof provided !== 'string') return false;
  const secret = Resource.CHAT_COMPLETION_INTERNAL_SECRET.value;
  if (isUnconfiguredSecret(secret)) return false;
  const expected = `Bearer ${secret}`;
  // Constant-time compare so a timing side-channel can't be used to recover the secret.
  // timingSafeEqual requires equal-length buffers, so guard on length first.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

const rawBodies = new WeakMap<IncomingMessage, Buffer>();

/** The dispatch signature is over the exact bytes the frontend sent, so it is checked against the raw body. */
function hasValidDispatchSignature(
  req: Request,
  identity: { questId: string; userId: string; sessionId: string }
): boolean {
  const raw = rawBodies.get(req);
  if (!raw) return false;
  return verifyQuestDispatch(Resource.CHAT_COMPLETION_INTERNAL_SECRET.value, identity, raw, {
    timestamp: req.headers[QUEST_DISPATCH_TIMESTAMP_HEADER],
    signature: req.headers[QUEST_DISPATCH_SIGNATURE_HEADER],
  });
}

/**
 * Register `POST /process` on the ChatCompletion Express app.
 *
 * @param track - registers the quest's processing promise with the service's SIGTERM drain
 *   set, so in-flight work finishes (bounded by DRAIN_TIMEOUT_MS) before exit.
 */
export function registerInternalRoutes(app: Express, track: (p: Promise<void>) => void): void {
  const routeLogger = new Logger({ metadata: { service: 'chatCompletion' } });

  // Auth gate. Runs BEFORE the 25MB JSON body parser so an unauthenticated caller can't
  // force a large-body parse - only an authorized /process request reaches express.json.
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!authorize(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  const parseJson = express.json({
    limit: '25mb',
    verify: (req, _res, buf) => {
      rawBodies.set(req, buf);
    },
  });

  app.post('/process', requireAuth, parseJson, (req: Request, res: Response) => {
    const parsed = QuestStartBodySchema.safeParse(req.body);
    if (!parsed.success) {
      routeLogger.warn('Rejected malformed /process payload', { issues: parsed.error.issues });
      res.status(400).json({ error: 'Invalid quest payload', issues: parsed.error.issues });
      return;
    }

    const params = parsed.data;
    if (!hasValidDispatchSignature(req, params)) {
      routeLogger.warn('Rejected /process request with a missing or invalid dispatch signature', {
        questId: params.questId,
      });
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const logger = new Logger({
      metadata: {
        service: 'chatCompletion',
        questId: params.questId,
        sessionId: params.sessionId,
        userId: params.userId,
      },
    });

    // ACK immediately - the browser is waiting on the /api/ai/llm response, not on us.
    // Results stream to the client over WebSocket as processQuest runs.
    res.status(202).json({ accepted: true, questId: params.questId });

    const task = processQuest(params, logger).catch(err =>
      handleQuestProcessingFailure(err, { questId: params.questId, logger, track, surface: '/process' })
    );
    track(task);
  });
}
