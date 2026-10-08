import express, { type Request, type Response } from 'express';
import { connectDB, mongoose } from '@bike4mind/database';
import { registerProcessErrorHandlers } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { registerInternalRoutes } from './internal/route';
import { registerExternalRoutes } from './external/sseRoute';
import { registerWsCompletionRoutes } from './external/wsRoute';
import { registerEmbedRoutes } from './external/embedRoute';

/**
 * ChatCompletion - always-on HTTP worker (Fargate). Serves both internal quest
 * processing (/process) and external chat completions (/api/ai/v1/completions), which is why
 * it's named for the general capability rather than quests specifically.
 *
 * Replaces the old EventBridge -> questProcessor Lambda. Serves two surfaces, split by folder:
 *   - internal/route.ts  -> POST /process: the frontend (`/api/ai/llm`, `/api/chat`)
 *     creates the quest, POSTs the QuestStartBody here, and gets a 202 back in ~milliseconds;
 *     we process it in-process (the container outlives the request, unlike a Lambda) and stream
 *     results over WebSocket. Guarded by a shared-secret bearer.
 *   - external/sseRoute.ts -> POST /api/ai/v1/completions: the user-authenticated
 *     CLI/3rd-party SSE completions endpoint (own API-key / JWT auth).
 *
 * Why this exists: a long-running container has no cold start and no 15-minute Lambda
 * timeout - the two problems the Lambda path suffered from.
 *
 * Reachability: served on a PUBLIC load balancer (so /api/ai/v1/completions can be exposed
 * under the bike4mind domain via CloudFront - see infra/chatCompletion.ts). /process is
 * reachable on the same ALB but is NOT routed through CloudFront and stays behind the
 * shared-secret bearer (see internal/route.ts); the endpoint uses its own user auth.
 */

// Default to 8788 for local dev (8080 is commonly taken on dev machines, e.g. Docker
// Desktop). The cloud container pins PORT=8080 via the Dockerfile ENV, and the ALB
// forwards 80->8080, so production is unaffected by this default.
const PORT = Number(process.env.PORT) || 8788;
const bootLogger = new Logger({ metadata: { service: 'chatCompletion' } });

// How long SIGTERM lets in-flight work finish before the process exits: ~10s under the ECS task
// `stopTimeout` (infra/chatCompletion.ts) so the drain-expiry error below can log before SIGKILL -
// a window equal to stopTimeout starts after SIGTERM and can never fire. The margin is pinned by
// server.test.ts; work still running when the window closes (e.g. a multi-minute deep-research
// generation) is still cut off. Requires node as PID 1 with tsx loaded in-process (see
// Dockerfile.chatcompletion) - a wrapper that exits first SIGKILLs the drain.
export const DRAIN_TIMEOUT_MS = 110_000;

// In-flight processing promises, tracked so SIGTERM can drain before exit. Both route
// modules register their work here via the shared `track` callback.
const inFlight = new Set<Promise<void>>();
const track = (p: Promise<void>) => {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
};

interface DrainLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
}

/**
 * Wait for the tracked in-flight work to settle, bounded by `drainTimeoutMs`. Exported
 * so a test can drive the cut-off branch without booting the service. Returns whether the
 * work drained or the window won; on the cut-off branch it emits an error naming the count
 * so LiveOps triage sees the quests a deploy/scale-in is about to SIGKILL (the WARN/INFO
 * line this replaces was invisible to the ERROR-level log subscription).
 */
export async function drainInFlight({
  inFlight,
  logger,
  drainTimeoutMs = DRAIN_TIMEOUT_MS,
}: {
  inFlight: Set<Promise<void>>;
  logger: DrainLogger;
  drainTimeoutMs?: number;
}): Promise<'drained' | 'timed-out'> {
  const drainTimeout = new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), drainTimeoutMs));
  const settled = Promise.allSettled([...inFlight]).then(() => 'drained' as const);
  const outcome = await Promise.race([settled, drainTimeout]);

  // `allSettled` winning means every promise's `track` cleanup already ran, so a non-empty
  // set here can only mean the timeout won with work still running.
  if (outcome === 'timed-out' && inFlight.size > 0) {
    logger.error('Drain window expired with in-flight quests - they will be cut off', { count: inFlight.size });
  }

  return outcome;
}

/**
 * Build the Express app (no `listen`, no DB connect, no signal handlers). Split out from
 * `main()` so tests can exercise the real middleware chain (auth gate -> body parser ->
 * Zod validation -> 202, and the SSE completions stream) over an ephemeral port without
 * booting the full service.
 */
export function createApp() {
  const app = express();

  // ALB health check. 200 = healthy; report unhealthy until Mongo is connected so a
  // half-booted task isn't routed traffic. No body parsing needed.
  app.get('/health', (_req: Request, res: Response) => {
    const ready = mongoose.connection.readyState === 1;
    res.status(ready ? 200 : 503).json({ ok: ready, readyState: mongoose.connection.readyState });
  });

  // Internal quest-processing surface (frontend Lambda -> WebSocket streaming).
  registerInternalRoutes(app, track);

  // External CLI/3rd-party completions endpoint (user-authenticated SSE stream). Registered on
  // the always-on service so it has no cold start / 15-min Lambda ceiling. Its in-flight streams
  // join the same drain set so SIGTERM lets them finish (bounded by DRAIN_TIMEOUT_MS).
  registerExternalRoutes(app, track);

  // CLI HTTP->WebSocket completions (POST payload here, chunks stream over the CLI's
  // WebSocket). Replaced the CliWsCompletionHandler Lambda; its background completions
  // join the same drain set.
  registerWsCompletionRoutes(app, track);

  // Public embed chat endpoint (agent-bound, anonymous end-user, org-billed SSE).
  // Same always-on rationale + drain set as the completions route.
  registerEmbedRoutes(app, track);

  return app;
}

async function main() {
  // Crash-safety for a long-running process: one request's mid-stream EPIPE / orphaned undici
  // rejection must NOT take Node's default uncaughtException path and kill the whole container
  // along with every other in-flight request. Registers global handlers that log + swallow the
  // network-error class without exiting. Must run before any request is served.
  registerProcessErrorHandlers(bootLogger, 'ChatCompletion');

  const app = createApp();

  const server = app.listen(PORT, () => {
    bootLogger.info(`ChatCompletion listening on :${PORT}`);
  });

  // Connect Mongo in the BACKGROUND, after we're already listening. This makes :8080
  // reachable in <1s, so the ALB health check gets a fast 503 (-> 200 once connected)
  // instead of a connection that hangs through the ~18s Mongo handshake. Blocking the
  // listen on connectDB previously left :8080 closed during boot, so health checks timed
  // out and ECS restart-looped the task. processQuest connects-if-needed, so /process is
  // safe even if a request lands before this resolves.
  // Deliberately does NOT drive model discovery: this service and the self-host
  // worker share one env file, so a startup leg here would arm a second driver
  // on the same flag and run a provider fan-out inside the inference process.
  // The worker is the single discovery driver (apps/workers/src/selfhost/main.ts).
  connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), bootLogger)
    .then(() => {
      bootLogger.info('MongoDB connected at boot');
    })
    .catch(err =>
      bootLogger.error('MongoDB connection failed at boot', {
        error: err instanceof Error ? err.message : String(err),
      })
    );

  // Graceful shutdown: stop accepting new work, let in-flight requests finish (bounded),
  // then exit. ECS sends SIGTERM, then SIGKILL after the stop timeout.
  const shutdown = (signal: string) => {
    bootLogger.info(`${signal} received - draining ${inFlight.size} in-flight request(s)`);
    server.close();
    void drainInFlight({ inFlight, logger: bootLogger }).finally(() => {
      bootLogger.info('Drain complete - exiting');
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
    bootLogger.error('ChatCompletion failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
