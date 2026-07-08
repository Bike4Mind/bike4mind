import { timingSafeEqual } from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { Resource } from 'sst';
import { questRepository } from '@bike4mind/database';
import { QuestStartBodySchema } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import { processQuest } from '@server/queueHandlers/questProcessor';

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
 * Shared-secret bearer check. Both the frontend Lambda and this service link
 * SECRET_ENCRYPTION_KEY, so the caller proves it's the frontend (not arbitrary internet
 * traffic that can reach the public ALB) by presenting it.
 */
export function authorize(req: Request): boolean {
  const provided = req.headers.authorization;
  if (typeof provided !== 'string') return false;
  const expected = `Bearer ${Resource.SECRET_ENCRYPTION_KEY.value}`;
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
      logger.error('Quest processing failed', { error: err instanceof Error ? err.message : String(err) });
      // Surface the failure to the client instead of leaving the quest 'running' forever.
      try {
        await questRepository.update({
          id: params.questId,
          status: 'stopped',
          replies: ['Something went wrong while processing your request. Please try again.'],
        });
      } catch (updateErr) {
        logger.error('Failed to mark quest stopped after processing error', {
          error: updateErr instanceof Error ? updateErr.message : String(updateErr),
        });
      }
    });
    track(task);
  });
}
