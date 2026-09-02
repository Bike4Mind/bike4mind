import { timingSafeEqual } from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Resource } from 'sst';
import { StandardUnit } from '@aws-sdk/client-cloudwatch';
import { questRepository } from '@bike4mind/database';
import { QuestStartBodySchema, categorizeToolError } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { processQuest } from '@server/queueHandlers/questProcessor';
import { emitMetrics } from '@server/utils/cloudwatch';

/**
 * Internal `/process` surface of the always-on ChatCompletion.
 *
 * Called only by the frontend Lambda (`/api/ai/llm`, `/api/chat`): it creates the quest, POSTs
 * the QuestStartBody here, and gets a 202 back in ~milliseconds; we process the quest in-process
 * (the container outlives the request, unlike a Lambda) and stream results over WebSocket.
 *
 * Not routed through CloudFront - reachable only on the ALB directly - and guarded by the
 * shared-secret bearer (`authorize`) as defense-in-depth. Contrast with the external
 * `/api/ai/v1/completions` route, which is public and uses its own user auth (API key / JWT).
 */

/**
 * Last-resort reply for a quest whose processing threw before anything specific was persisted.
 * Only ever written when `settleIfUnfinished` finds the quest still unfinished - see the catch in
 * `registerInternalRoutes`.
 */
export const GENERIC_PROCESSING_FAILURE_REPLY = 'Something went wrong while processing your request. Please try again.';

/**
 * Namespace for quest-lifecycle operational metrics; also used by the timeout sweep
 * (apps/client/server/cron/questTimeoutSweep.ts). Keep the `ProcessingFailed` metric name and its
 * `Stage` dimension in sync with infra/alarms.ts.
 */
const QUESTS_CLOUDWATCH_NAMESPACE = 'Lumina5/Quests';

/**
 * Shared-secret bearer check. Both the frontend Lambda and this service link
 * CHAT_COMPLETION_INTERNAL_SECRET (a dedicated internal-dispatch secret, NOT the AES
 * SECRET_ENCRYPTION_KEY), so the caller proves it's the frontend (not arbitrary internet
 * traffic that can reach the public ALB) by presenting it. Must match dispatchQuest.ts.
 */
export function authorize(req: Request): boolean {
  const provided = req.headers.authorization;
  if (typeof provided !== 'string') return false;
  const expected = `Bearer ${Resource.CHAT_COMPLETION_INTERNAL_SECRET.value}`;
  // Constant-time compare so a timing side-channel can't be used to recover the secret.
  // timingSafeEqual requires equal-length buffers, so guard on length first.
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
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

  app.post('/process', requireAuth, express.json({ limit: '25mb' }), (req: Request, res: Response) => {
    const parsed = QuestStartBodySchema.safeParse(req.body);
    if (!parsed.success) {
      routeLogger.warn('Rejected malformed /process payload', { issues: parsed.error.issues });
      res.status(400).json({ error: 'Invalid quest payload', issues: parsed.error.issues });
      return;
    }

    const params = parsed.data;
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

    const task = processQuest(params, logger).catch(async err => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('Quest processing failed', { error: errorMessage });

      // Operator-facing signal only - the quest's own reply to the user is handled separately
      // below. Without this, detection of a processing failure was "a user complains": nothing
      // alerted an operator. ErrorClass reuses the same taxonomy as tool-call telemetry
      // (categorizeToolError) rather than inventing a second one, so a rate-limit storm is visible -
      // and alarmable - by class, not just as an undifferentiated count. categorizeToolError has no
      // rule for a credential error, so an invalid-API-key failure still lands in internal_error
      // alongside other unclassified throws - a known gap, tracked separately.
      //
      // Two datums, same metric name: CloudWatch keys a custom metric by namespace + name + the
      // EXACT dimension set and never rolls one up into the other, so the Stage-only point is what
      // the alarm below watches (a per-class dimension set would leave it permanently
      // INSUFFICIENT_DATA) while the Stage+ErrorClass point drives the "which class is failing"
      // dashboard breakdown. Neither double-counts the other since they are distinct series.
      const stage = Resource.App.stage;
      const errorClass = categorizeToolError(errorMessage);
      void emitMetrics(QUESTS_CLOUDWATCH_NAMESPACE, [
        { name: 'ProcessingFailed', value: 1, dimensions: { Stage: stage }, unit: StandardUnit.Count },
        {
          name: 'ProcessingFailed',
          value: 1,
          dimensions: { Stage: stage, ErrorClass: errorClass },
          unit: StandardUnit.Count,
        },
      ]);

      // Surface the failure to the client instead of leaving the quest 'running' forever - but only
      // when nothing terminal was written yet. ChatCompletionProcess persists the provider's own
      // message (`quest.reply = err.message`) and marks the quest terminal before it rethrows, so an
      // unconditional write here replaces a specific, actionable diagnostic with this generic one.
      try {
        const settled = await questRepository.settleIfUnfinished(params.questId, {
          status: 'stopped',
          type: 'error',
          reply: GENERIC_PROCESSING_FAILURE_REPLY,
        });
        if (!settled) {
          logger.info('Quest already settled by the processor; kept its own error reply', {
            questId: params.questId,
          });
        }
      } catch (updateErr) {
        logger.error('Failed to mark quest stopped after processing error', {
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    });
    track(task);
  });
}
