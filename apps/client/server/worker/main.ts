import type { SQSEvent } from 'aws-lambda';
import { taskSchedulerService } from '@bike4mind/services';
import { taskScheduleRepository, connectDB, FabFile, adminSettingsRepository } from '@bike4mind/database';
import { TaskScheduleHandler } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import { Config } from '@server/utils/config';
import { sendToQueue } from '@server/utils/sqs';
import { dispatch as researchEngineDispatch } from '@server/queueHandlers/researchEngineQueue';
import { dispatch as fabFileChunkDispatch } from '@server/queueHandlers/fabFileChunk';
import { dispatch as fabFileVectorizeDispatch } from '@server/queueHandlers/fabFileVectorize';
import { SelfHostWorker } from './selfHostWorker';
import { dispatchSelfHostEvent } from './eventDispatch';

/**
 * Self-host background worker entrypoint.
 *
 * Run as its own compose service (reuses Dockerfile.chatcompletion.selfhost with a
 * command override) via `tsx --import ./server/chatCompletion/selfhostSstAlias.mjs`
 * so `Resource.*` reads resolve from env. It is the self-host stand-in for the hosted
 * SST queue consumers (infra/queues.ts) and cron (infra/cron.ts):
 *   - polls researchEngineQueue -> researchEngineQueue.dispatch (same handler as hosted)
 *   - runs taskSchedulerService.process every 5 minutes with the same handler map as
 *     the hosted cron/scheduler.ts (kept in sync with it).
 */

const bootLogger = new Logger({ metadata: { service: 'selfHostWorker' } });

/** Research generations can run for minutes; keep the message invisible while in flight. */
const RESEARCH_VISIBILITY_TIMEOUT_SEC = 900;
/** Chunking/embedding a file (esp. local Ollama embeddings on CPU) can take minutes. */
const FAB_FILE_VISIBILITY_TIMEOUT_SEC = 300;
/** Scheduler cadence (hosted cron runs on a schedule; self-host polls the schedule table). */
const SCHEDULER_INTERVAL_MS = 5 * 60_000;
/** Safety-net scan cadence: catches uploads whose MinIO webhook never arrived. */
const CHUNK_SCAN_INTERVAL_MS = 60_000;
/** Only rescue files older than this, to avoid racing a webhook that is about to arrive. */
const CHUNK_SCAN_MIN_AGE_MS = 2 * 60_000;
/** Cap files enqueued per scan pass so a large backlog is drained gradually. */
const CHUNK_SCAN_BATCH = 50;
/** Grace period on SIGTERM/SIGINT for in-flight message handling to finish before exit. */
const DRAIN_GRACE_MS = 20_000;

async function main() {
  // This process only makes sense in self-host: it uses the env-backed Resource shim and
  // ElasticMQ. Refuse to run elsewhere so it can never poll a real AWS queue by accident.
  if (process.env.B4M_SELF_HOST !== 'true') {
    bootLogger.error('selfHostWorker refuses to start: B4M_SELF_HOST must be "true" (self-host only).');
    process.exit(1);
  }

  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), bootLogger);
  bootLogger.info('MongoDB connected');

  const worker = new SelfHostWorker(bootLogger);

  worker.registerQueueHandler('researchEngineQueue', Resource.researchEngineQueue.url, researchEngineDispatch, {
    visibilityTimeoutSec: RESEARCH_VISIBILITY_TIMEOUT_SEC,
  });

  // RAG ingestion pipeline: chunk a fab file, then vectorize its chunks in batches.
  // The webhook / scan (server/... object-created, scheduler scan) enqueues fabFileChunkQueue;
  // fabFileChunk fans out to fabFileVectorizeQueue. Same dispatch handlers as hosted.
  worker.registerQueueHandler('fabFileChunkQueue', Resource.fabFileChunkQueue.url, fabFileChunkDispatch, {
    visibilityTimeoutSec: FAB_FILE_VISIBILITY_TIMEOUT_SEC,
  });
  worker.registerQueueHandler('fabFileVectorizeQueue', Resource.fabFileVectorizeQueue.url, fabFileVectorizeDispatch, {
    visibilityTimeoutSec: FAB_FILE_VISIBILITY_TIMEOUT_SEC,
  });

  // Enrichment events (naming, summaries, tags, memento embedding) arrive here from
  // eventBus.publishSelfHost as { detailType, detail }. Read straight from env (not the
  // Resource shim): this queue is self-host-only, so it isn't in the hosted SST types.
  // Optional - unset means enrichment simply doesn't run.
  const eventQueueUrl = process.env.SELF_HOST_EVENT_QUEUE;
  if (eventQueueUrl) {
    worker.registerQueueHandler(
      'selfHostEventQueue',
      eventQueueUrl,
      async (event: SQSEvent) => {
        const { detailType, detail } = JSON.parse(event.Records[0].body) as { detailType: string; detail: unknown };
        await dispatchSelfHostEvent(detailType, detail, bootLogger);
      },
      // Enrichment handlers make local-LLM calls (naming, summaries) that can run minutes on
      // CPU: keep the message invisible long enough to avoid mid-run redelivery + duplicate work.
      { visibilityTimeoutSec: 300, maxReceiveCount: 5 }
    );
  } else {
    bootLogger.warn('SELF_HOST_EVENT_QUEUE not set; enrichment events will not be consumed');
  }

  // Mirrors cron/scheduler.ts (hosted). Keep the handler map in sync with it.
  worker.registerScheduledTask('scheduler', SCHEDULER_INTERVAL_MS, async () => {
    await taskSchedulerService.process({
      db: { taskSchedules: taskScheduleRepository },
      logger: bootLogger,
      handlers: {
        [TaskScheduleHandler.RESEARCH_TASK_PROCESS]: async payload => {
          await sendToQueue(Resource.researchEngineQueue.url, payload);
        },
        [TaskScheduleHandler.CUSTOM_TASK_PROCESS]: async () => {},
      },
    });
  });

  // Safety net for the MinIO webhook (pages/api/internal/s3/object-created.ts): if a
  // notification is missed, sweep un-chunked files and enqueue them. isChunking / chunkCount
  // exclude in-progress and done files; the age filter avoids racing an in-flight webhook.
  worker.registerScheduledTask('fabFileChunkScan', CHUNK_SCAN_INTERVAL_MS, async () => {
    if (!(await adminSettingsRepository.getSettingsValue('enableAutoChunk'))) return;

    const cutoff = new Date(Date.now() - CHUNK_SCAN_MIN_AGE_MS);
    const candidates = await FabFile.find({
      chunkCount: 0,
      isChunking: { $ne: true },
      createdAt: { $lt: cutoff },
      deletedAt: null,
    })
      .select('_id userId')
      .limit(CHUNK_SCAN_BATCH)
      .lean();

    for (const file of candidates) {
      await sendToQueue(Resource.fabFileChunkQueue.url, {
        fabFileId: String(file._id),
        userId: file.userId,
        chunkSize: '1000',
      });
    }
    if (candidates.length > 0) {
      bootLogger.info(`[fabFileChunkScan] enqueued ${candidates.length} un-chunked file(s)`);
    }
  });

  worker.start();

  const shutdown = async (signal: string) => {
    bootLogger.info(`${signal} received - draining selfHostWorker (up to ${DRAIN_GRACE_MS}ms)`);
    await worker.stop(DRAIN_GRACE_MS);
    bootLogger.info('selfHostWorker drained; exiting');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Boot except under test (vitest sets VITEST) - importing this module for unit tests must
// not connect Mongo, start pollers, or install signal handlers (mirrors server.ts).
if (!process.env.VITEST) {
  main().catch(err => {
    bootLogger.error('selfHostWorker failed to start', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}
