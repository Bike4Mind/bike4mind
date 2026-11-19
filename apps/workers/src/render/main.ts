import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { Resource } from 'sst';
import {
  STUDIO_RENDER_MAX_WALL_CLOCK_MS,
  StudioRenderQueueMessageSchema,
  StudioRenderStatusSchema,
  studioRenderStatusKey,
  type StudioRenderStatus,
} from '@bike4mind/common';
import { connectDB, fabFileRepository, generationJobRepository, mongoose } from '@bike4mind/database';
import { installConsoleRedaction, Logger } from '@bike4mind/observability';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { renderMessageDisposition, type RenderMessageResult } from './disposition';
import { detectFfmpegMajorVersion, probeHasAudio, runFfmpeg } from './ffmpeg';
import { runRender, type RunRenderDeps } from './runRender';
import { createRenderTaskProtection } from './taskProtection';

/**
 * The render worker: a long-running container (Kubernetes, or the self-host compose profile) that takes one render
 * job at a time off the render queue and encodes it with ffmpeg. Reads through `Resource` like every self-host
 * process, so it runs with the sst -> @bike4mind/resource alias hook and resolves from env (b4m-core/resource
 * manifest): RENDER_JOB_QUEUE (consume), GENERATION_JOB_QUEUE (wake the engine), FAB_FILE_BUCKET (read sources),
 * GENERATED_IMAGES_BUCKET (write output + status), MONGODB_URI and APP_STAGE.
 */

const logger = new Logger({ metadata: { service: 'renderWorker' } });

// One receive covers the whole render budget plus a margin, matching renderJobQueue's visibility timeout
// (infra/queues.ts), so a running render is never redelivered to a second task. A crashed task's job is not retried
// within its deadline: the engine fails it at the deadline and refunds the hold.
const VISIBILITY_SECONDS = Math.ceil(STUDIO_RENDER_MAX_WALL_CLOCK_MS / 1000) + 5 * 60;
const RECEIVE_WAIT_SECONDS = 20;
// After SIGTERM the render in flight gets this long to finish before it is aborted and handed back to the queue.
// Keep it under the pod's terminationGracePeriodSeconds.
const DEFAULT_DRAIN_GRACE_MS = 90_000;
const RECEIVE_ERROR_BACKOFF_MS = 5_000;
const WORK_DIR_PREFIX = 'studio-render-';

const linkedUrl = (name: 'renderJobQueue' | 'generationJobQueue'): string => {
  // renderJobQueue is optional in the manifest and absent from some generated Resource types, so both are read
  // through one untyped shape and checked here.
  const url = (Resource as unknown as Record<string, { url?: string } | undefined>)[name]?.url;
  if (!url) throw new Error(`${name} is not linked to the render worker`);
  return url;
};

const isMissingObjectError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound');

const readStatus = async (jobId: string): Promise<StudioRenderStatus | null> => {
  let raw: string;
  try {
    raw = await getGeneratedImageStorage().getContentAsString(studioRenderStatusKey(jobId));
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
  const parsed = StudioRenderStatusSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
};

const downloadSource = async (filePath: string, destination: string, signal: AbortSignal): Promise<void> => {
  const body = await getFilesStorage().getContent(filePath);
  if (!(body instanceof Readable)) throw new Error('source download did not return a stream');
  await pipeline(body, createWriteStream(destination), { signal });
};

/**
 * Removes work dirs a killed render left behind. The Kubernetes chart mounts /tmp as an emptyDir, which survives a
 * container restart, and this task runs one render at a time, so at startup none of them is in use.
 */
const sweepStaleWorkDirs = async (): Promise<void> => {
  const tmpDir = os.tmpdir();
  try {
    const stale = (await readdir(tmpDir)).filter(name => name.startsWith(WORK_DIR_PREFIX));
    await Promise.all(stale.map(name => rm(path.join(tmpDir, name), { recursive: true, force: true })));
    if (stale.length > 0) logger.info('removed stale render work dirs', { count: stale.length });
  } catch (error) {
    logger.warn('stale render work dir sweep failed', { error: error instanceof Error ? error.message : String(error) });
  }
};

const buildDeps = (generationJobQueueUrl: string, ffmpegMajorVersion: number): RunRenderDeps => ({
  loadJob: jobId => generationJobRepository.findById(jobId),
  findReadableFiles: (fileIds, userId) => fabFileRepository.findAccessibleInIds(fileIds, { userId }),
  downloadSource,
  probeHasAudio,
  readStatus,
  writeStatus: async (jobId, status) => {
    await getGeneratedImageStorage().upload(JSON.stringify(status), studioRenderStatusKey(jobId), {
      ContentType: 'application/json',
    });
  },
  uploadOutput: async (localPath, key, signal) => {
    await getGeneratedImageStorage().uploadFile(localPath, key, { ContentType: 'video/mp4' }, signal);
  },
  enqueueStep: async jobId => {
    await sendToQueue(generationJobQueueUrl, { jobId });
  },
  runFfmpeg,
  ffmpegMajorVersion,
  makeWorkDir: () => mkdtemp(path.join(os.tmpdir(), WORK_DIR_PREFIX)),
  removeWorkDir: workDir => rm(workDir, { recursive: true, force: true }),
  writeTextFile: (filePath, content) => writeFile(filePath, content, 'utf8'),
  fileSize: async filePath => (await stat(filePath)).size,
  now: () => new Date(),
  logger,
});

const parseJson = (body: string | undefined): unknown => {
  try {
    return JSON.parse(body ?? '');
  } catch {
    return null;
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  installConsoleRedaction();
  await sweepStaleWorkDirs();
  const queueUrl = linkedUrl('renderJobQueue');
  const ffmpegMajorVersion = await detectFfmpegMajorVersion(AbortSignal.timeout(10_000));
  const deps = buildDeps(linkedUrl('generationJobQueue'), ffmpegMajorVersion);
  const graceMs = Number(process.env.RENDER_DRAIN_GRACE_MS ?? DEFAULT_DRAIN_GRACE_MS);
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('RENDER_DRAIN_GRACE_MS must be a non-negative number');

  const sqs = new SQSClient({});
  const protection = createRenderTaskProtection({ agentUri: process.env.ECS_AGENT_URI, logger });
  const stopReceiving = new AbortController();
  const abortRender = new AbortController();

  const shutdown = (signalName: string) => {
    if (stopReceiving.signal.aborted) return;
    logger.info('render worker stopping', { signal: signalName, graceMs });
    stopReceiving.abort();
    setTimeout(() => abortRender.abort(new Error('shutdown grace period elapsed')), graceMs).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);
  logger.info('render worker started', { ffmpegMajorVersion });

  const changeVisibility = (message: Message, seconds: number) =>
    sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: seconds,
      })
    );

  const settle = async (message: Message, result: RenderMessageResult): Promise<void> => {
    const disposition = renderMessageDisposition(result);
    if (disposition.action === 'delete') {
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    } else if (disposition.action === 'change_visibility') {
      await changeVisibility(message, disposition.seconds);
    }
  };

  const processMessage = async (message: Message): Promise<RenderMessageResult> => {
    if (stopReceiving.signal.aborted) return { outcome: 'shutting_down' };
    const parsed = StudioRenderQueueMessageSchema.safeParse(parseJson(message.Body));
    if (!parsed.success) {
      logger.error('dropping malformed render queue message', { messageId: message.MessageId });
      return { outcome: 'malformed' };
    }
    const { jobId } = parsed.data;
    await protection.set(true);
    try {
      const result = await runRender(jobId, deps, { signal: abortRender.signal });
      logger.info('render job handled', { jobId, ...result });
      return result;
    } catch (error) {
      logger.error('render job errored; leaving the message for redelivery', {
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: 'errored' };
    } finally {
      await protection.set(false);
    }
  };

  const handle = async (message: Message): Promise<void> => {
    try {
      await settle(message, await processMessage(message));
    } catch (error) {
      logger.error('render queue message settle failed', {
        messageId: message.MessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  while (!stopReceiving.signal.aborted) {
    let messages: Message[];
    try {
      const response = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
          VisibilityTimeout: VISIBILITY_SECONDS,
        }),
        { abortSignal: stopReceiving.signal }
      );
      messages = response.Messages ?? [];
    } catch (error) {
      if (stopReceiving.signal.aborted) break;
      logger.error('render queue receive failed', { error: error instanceof Error ? error.message : String(error) });
      await delay(RECEIVE_ERROR_BACKOFF_MS);
      continue;
    }
    for (const message of messages) await handle(message);
  }

  sqs.destroy();
  await mongoose.disconnect();
  logger.info('render worker stopped');
}

void main()
  .then(() => process.exit(0))
  .catch(error => {
    logger.error('render worker failed', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
