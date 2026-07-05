import { timingSafeEqual } from 'crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { Resource } from 'sst';
import { connectDB, mongoose, questRepository } from '@bike4mind/database';
import { QuestStartBodySchema } from '@bike4mind/services';
import { registerProcessErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { processQuest } from '@server/queueHandlers/questProcessor';

/**
 * QuestProcessorService - always-on HTTP worker.
 *
 * Replaces the old EventBridge -> questProcessor Lambda. The frontend (`/api/ai/llm`,
 * `/api/chat`) creates the quest, then POSTs the QuestStartBody here and gets a 202
 * back in ~milliseconds. We process the quest in-process (the container outlives the
 * HTTP request, unlike a Lambda) and stream results over the existing WebSocket path.
 *
 * Why this exists: a long-running container has no cold start and no 15-minute Lambda
 * timeout - the two problems the Lambda path suffered from.
 *
 * Reachability: served on a VPC-internal load balancer, so only the frontend Lambda
 * (same VPC) can reach it. A shared-secret bearer (SECRET_ENCRYPTION_KEY, which both
 * sides already link) is checked as defense-in-depth on top of the network boundary.
 */

// Default to 8788 for local dev (8080 is commonly taken on dev machines, e.g. Docker
// Desktop). The cloud container pins PORT=8080 via the Dockerfile ENV, and the ALB
// forwards 80->8080, so production is unaffected by this default.
const PORT = Number(process.env.PORT) || 8788;
const bootLogger = new Logger({ metadata: { service: 'questProcessorService' } });

// How long SIGTERM lets in-flight quests finish before the process exits. Kept in
// lock-step with the ECS task `stopTimeout` (infra/questProcessorService.ts) - ECS
// sends SIGKILL at stopTimeout, so draining any longer is pointless. 120s is the ECS
// stopTimeout ceiling. NOTE: a quest still running past this window (e.g. a multi-minute
// deep-research generation) is still cut off by a deploy/scale-in SIGTERM - see the PR
// description's trade-off note. The container removes the cold-start + 15-min Lambda
// ceiling for the steady-state path; it does not make shutdown-time cancellation free.
const DRAIN_TIMEOUT_MS = 120_000;

// In-flight quest processing promises, tracked so SIGTERM can drain before exit.
const inFlight = new Set<Promise<void>>();

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
 * Build the Express app (no `listen`, no DB connect, no signal handlers). Split out from
 * `main()` so tests can exercise the real middleware chain (auth gate -> body parser ->
 * Zod validation -> 202) over an ephemeral port without booting the full service.
 */
export function createApp() {
  const app = express();

  // ALB health check. 200 = healthy; report unhealthy until Mongo is connected so a
  // half-booted task isn't routed traffic. No body parsing needed.
  app.get('/health', (_req: Request, res: Response) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ ok: ready, readyState: mongoose.connection.readyState });
  });

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
      bootLogger.warn('Rejected malformed /process payload', { issues: parsed.error.issues });
      res.status(400).json({ error: 'Invalid quest payload', issues: parsed.error.issues });
      return;
    }

    const params = parsed.data;
    const logger = new Logger({
      metadata: {
        service: 'questProcessorService',
        questId: params.questId,
        sessionId: params.sessionId,
        userId: params.userId,
      },
    });

    // ACK immediately - the browser is waiting on the /api/ai/llm response, not on us.
    // Results stream to the client over WebSocket as processQuest runs.
    res.status(202).json({ accepted: true, questId: params.questId });

    const task = processQuest(params, logger)
      .catch(async err => {
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
      })
      .finally(() => {
        inFlight.delete(task);
      });
    inFlight.add(task);
  });

  return app;
}

async function main() {
  // Crash-safety for a long-running process: one quest's mid-stream EPIPE / orphaned undici
  // rejection must NOT take Node's default uncaughtException path and kill the whole container
  // along with every other in-flight quest. Registers global handlers that log + swallow the
  // network-error class without exiting. Must run before any request is served.
  registerProcessErrorHandlers(bootLogger, 'QuestProcessorService');

  const app = createApp();

  const server = app.listen(PORT, () => {
    bootLogger.info(`QuestProcessorService listening on :${PORT}`);
  });

  // Connect Mongo in the BACKGROUND, after we're already listening. This makes :8080
  // reachable in <1s, so the ALB health check gets a fast 503 (-> 200 once connected)
  // instead of a connection that hangs through the ~18s Mongo handshake. Blocking the
  // listen on connectDB previously left :8080 closed during boot, so health checks timed
  // out and ECS restart-looped the task. processQuest connects-if-needed, so /process is
  // safe even if a request lands before this resolves.
  connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), bootLogger)
    .then(() => bootLogger.info('MongoDB connected at boot'))
    .catch(err =>
      bootLogger.error('MongoDB connection failed at boot', {
        error: err instanceof Error ? err.message : String(err),
      })
    );

  // Graceful shutdown: stop accepting new work, let in-flight quests finish (bounded),
  // then exit. ECS sends SIGTERM, then SIGKILL after the stop timeout.
  const shutdown = (signal: string) => {
    bootLogger.info(`${signal} received — draining ${inFlight.size} in-flight quest(s)`);
    server.close();
    const drainTimeout = new Promise<void>(resolve => setTimeout(resolve, DRAIN_TIMEOUT_MS));
    Promise.race([Promise.allSettled([...inFlight]), drainTimeout]).finally(() => {
      bootLogger.info('Drain complete — exiting');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Boot the service, except under test - importing this module for unit tests must not
// start listening / connect Mongo / install signal handlers (vitest sets VITEST=true).
if (!process.env.VITEST) {
  main().catch(err => {
    bootLogger.error('QuestProcessorService failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
