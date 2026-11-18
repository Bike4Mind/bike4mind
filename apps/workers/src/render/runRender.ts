import path from 'node:path';
import {
  buildStudioRenderPlan,
  isImageServeable,
  StudioRenderPlanError,
  studioRenderBareMimeType,
  studioRenderOutputKey,
  studioTimelineFileIds,
  STUDIO_RENDER_IMAGE_EXTENSIONS,
  STUDIO_RENDER_MAX_WALL_CLOCK_MS,
  isGenerationJobOfKind,
  type IGenerationJobDocument,
  type IGenerationJobDocumentOf,
  type StudioRenderSource,
  type StudioRenderSourceKind,
  type StudioRenderStatus,
} from '@bike4mind/common';

/**
 * One render job, end to end on the worker: load the job, re-check the owner can still read every clip, download,
 * encode with ffmpeg, upload the MP4 and report through the status object. The worker never writes the job
 * document: the engine's scheduled poll (b4m-core/services/src/renderJobs/renderJobHandler.ts) reads the status and
 * advances the job. The step the worker enqueues after a terminal status is only a nudge; the engine drops a delivery
 * that arrives well before the job's next poll, so it helps only when no poll is scheduled soon.
 */

export type RenderSourceFile = {
  id: string;
  filePath?: string | null;
  mimeType?: string | null;
  moderationStatus?: string | null;
  deletedAt?: Date | null;
};

export type RunRenderLogger = {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
};

export type FfmpegRun = {
  args: string[];
  signal: AbortSignal;
  /** Called with each `-progress` out_time, in ms of output encoded. */
  onProgress: (outTimeMs: number) => void;
};

export type RunRenderDeps = {
  loadJob: (jobId: string) => Promise<IGenerationJobDocument | null>;
  /** The files among `fileIds` that `userId` can read now; the same predicate the export route checked at create. */
  findReadableFiles: (fileIds: string[], userId: string) => Promise<RenderSourceFile[]>;
  downloadSource: (filePath: string, destination: string, signal: AbortSignal) => Promise<void>;
  probeHasAudio: (localPath: string, signal: AbortSignal) => Promise<boolean>;
  readStatus: (jobId: string) => Promise<StudioRenderStatus | null>;
  writeStatus: (jobId: string, status: StudioRenderStatus) => Promise<void>;
  uploadOutput: (localPath: string, key: string, signal: AbortSignal) => Promise<void>;
  /** Wakes the engine's step for the job (generationJobQueue). */
  enqueueStep: (jobId: string) => Promise<void>;
  runFfmpeg: (run: FfmpegRun) => Promise<void>;
  ffmpegMajorVersion: number;
  makeWorkDir: () => Promise<string>;
  removeWorkDir: (workDir: string) => Promise<void>;
  writeTextFile: (filePath: string, content: string) => Promise<void>;
  fileSize: (filePath: string) => Promise<number>;
  now: () => Date;
  logger: RunRenderLogger;
};

export type RunRenderOutcome =
  /** `in_progress`: another task is encoding the job now (its heartbeat is fresh) and still holds its own message. */
  | { outcome: 'skipped'; reason: 'missing' | 'not_render' | 'not_running' | 'cancel_requested' | 'in_progress' }
  /** Dispatched before the engine committed `running`: the caller redelivers the message shortly instead of dropping it. */
  | { outcome: 'not_yet_running' }
  | { outcome: 'already_succeeded' }
  | { outcome: 'succeeded'; bytes: number; durationSeconds: number }
  | { outcome: 'failed'; message: string }
  /** The job was cancelled or ended mid-encode: the encode is killed and no status is written. */
  | { outcome: 'cancelled' }
  /** Stopped by the caller (the task is shutting down); `released` is whether the status write that lets a redelivery retry landed. */
  | { outcome: 'aborted'; released: boolean };

/** Room left under the job's deadline to upload, write the status and let the engine store before it expires. */
export const DEADLINE_MARGIN_MS = 5 * 60_000;
export const PROGRESS_WRITE_INTERVAL_MS = 5_000;
export const PROGRESS_MIN_DELTA = 0.01;
/**
 * How often an encode re-stamps its `running` status and re-checks that the job is still running. Progress writes
 * alone are not a heartbeat: none happen while sources download, and they skip ticks that move under the minimum delta.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A `running` status stamped this recently belongs to a live encode on another task. */
export const RUNNING_STATUS_FRESH_MS = 3 * HEARTBEAT_INTERVAL_MS;
// Stamped by a task that hands its job back on shutdown, so the redelivery does not take it for a live encode.
const RELEASED_UPDATED_AT = new Date(0).toISOString();

/** A failure whose message is safe to show the user as is. Anything else is reported generically. */
export class RenderUserError extends Error {
  override name = 'RenderUserError';
}

const GENERIC_FAILURE = 'The render failed while encoding the video.';
const TIMEOUT_FAILURE = 'The render did not finish in time.';
const MAX_STATUS_MESSAGE = 500;

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const userMessageOf = (error: unknown): string => {
  if (error instanceof RenderUserError || error instanceof StudioRenderPlanError) {
    return error.message.slice(0, MAX_STATUS_MESSAGE);
  }
  return GENERIC_FAILURE;
};

const kindOfMime = (mimeType: string | null | undefined): StudioRenderSourceKind | null => {
  const type = studioRenderBareMimeType(mimeType);
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  return null;
};

// image2 picks its decoder from the extension, and the render plan reads `.gif` to loop a GIF its own way.
const localNameFor = (index: number, kind: StudioRenderSourceKind, mimeType: string | null | undefined): string => {
  if (kind !== 'image') return `source-${index}`;
  const extension = STUDIO_RENDER_IMAGE_EXTENSIONS[studioRenderBareMimeType(mimeType)];
  if (!extension) throw new RenderUserError('A timeline image is in a format the renderer cannot read');
  return `source-${index}${extension}`;
};

/** Combines the caller's abort with the deadline timer; `timedOut()` tells the two apart afterwards. */
const deadlineSignal = (external: AbortSignal, budgetMs: number) => {
  const controller = new AbortController();
  let didTimeOut = false;
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('render deadline reached'));
  }, budgetMs);
  const onAbort = () => controller.abort(external.reason);
  if (external.aborted) onAbort();
  else external.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer);
      external.removeEventListener('abort', onAbort);
    },
  };
};

const resolveSources = async (
  job: IGenerationJobDocumentOf<'render'>,
  workDir: string,
  signal: AbortSignal,
  deps: RunRenderDeps
): Promise<Map<string, StudioRenderSource>> => {
  const { timeline } = job.payload.request;
  // Disabled tracks draw nothing, so their files are neither checked nor downloaded.
  const fileIds = studioTimelineFileIds({ ...timeline, tracks: timeline.tracks.filter(track => track.enabled) });
  if (fileIds.length === 0) return new Map();

  const readable = new Map((await deps.findReadableFiles(fileIds, job.requestedBy)).map(file => [file.id, file]));
  const sources = new Map<string, StudioRenderSource>();
  for (const [index, fileId] of fileIds.entries()) {
    const file = readable.get(fileId);
    if (!file || !file.filePath || file.deletedAt) {
      throw new RenderUserError('A file used in this Production is no longer available to you');
    }
    if (!isImageServeable(file)) throw new RenderUserError('A file used in this Production is still being checked');
    const kind = kindOfMime(file.mimeType);
    if (!kind) throw new RenderUserError('A file used in this Production is not a video, image or audio file');
    const localPath = path.join(workDir, localNameFor(index, kind, file.mimeType));
    await deps.downloadSource(file.filePath, localPath, signal);
    const hasAudio = kind === 'image' ? false : await probe(localPath, signal, deps);
    sources.set(fileId, { localPath, kind, hasAudio });
  }
  return sources;
};

const probe = async (localPath: string, signal: AbortSignal, deps: RunRenderDeps): Promise<boolean> => {
  try {
    return await deps.probeHasAudio(localPath, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    deps.logger.warn('render source probe failed', { error: errorMessage(error) });
    throw new RenderUserError('A file used in this Production could not be read as media');
  }
};

/**
 * Serializes status writes so a slow progress write can never land after the final one, and drops any progress
 * (a late ffmpeg tick or heartbeat) once the final write has begun.
 */
const createStatusWriter = (jobId: string, deps: RunRenderDeps) => {
  let chain: Promise<void> = Promise.resolve();
  let closed = false;
  return {
    progress(status: StudioRenderStatus) {
      if (closed) return;
      chain = chain.then(() =>
        deps.writeStatus(jobId, status).catch(error => {
          deps.logger.warn('render progress write failed', { jobId, error: errorMessage(error) });
        })
      );
    },
    async final(status: StudioRenderStatus) {
      closed = true;
      await chain;
      await deps.writeStatus(jobId, status);
    },
  };
};

type StatusWriter = ReturnType<typeof createStatusWriter>;

/** The latest encode progress, shared by ffmpeg's progress callback and the heartbeat. */
type ProgressTracker = { latest: number };

const isStillRunning = (job: IGenerationJobDocument | null): boolean =>
  job !== null && job.state === 'running' && !job.cancelRequested;

/**
 * Every HEARTBEAT_INTERVAL_MS: re-stamps the `running` status (the liveness RUNNING_STATUS_FRESH_MS checks) and
 * re-loads the job, aborting `cancel` once it was cancelled or ended. Returns the stop function.
 */
const startHeartbeat = (
  jobId: string,
  tracker: ProgressTracker,
  statusWriter: StatusWriter,
  cancel: AbortController,
  deps: RunRenderDeps
): (() => void) => {
  let beating = false;
  const beat = async () => {
    statusWriter.progress({ state: 'running', progress: tracker.latest, updatedAt: deps.now().toISOString() });
    try {
      if (!isStillRunning(await deps.loadJob(jobId))) {
        deps.logger.info('render job no longer running; stopping the encode', { jobId });
        cancel.abort(new Error('render job is no longer running'));
      }
    } catch (error) {
      deps.logger.warn('render job re-check failed', { jobId, error: errorMessage(error) });
    }
  };
  const timer = setInterval(() => {
    if (beating || cancel.signal.aborted) return;
    beating = true;
    void beat().finally(() => {
      beating = false;
    });
  }, HEARTBEAT_INTERVAL_MS);
  return () => clearInterval(timer);
};

const encode = async (
  job: IGenerationJobDocumentOf<'render'>,
  signal: AbortSignal,
  statusWriter: StatusWriter,
  tracker: ProgressTracker,
  deps: RunRenderDeps
): Promise<{ bytes: number; durationSeconds: number }> => {
  const workDir = await deps.makeWorkDir();
  try {
    const { timeline, output } = job.payload.request;
    const sources = await resolveSources(job, workDir, signal, deps);
    const outputPath = path.join(workDir, 'output.mp4');
    const plan = buildStudioRenderPlan({
      timeline,
      output,
      sources,
      outputPath,
      filterScriptPath: path.join(workDir, 'filtergraph.txt'),
      captionTextPath: index => path.join(workDir, `caption-${index}.txt`),
      ffmpegMajorVersion: deps.ffmpegMajorVersion,
    });
    for (const file of plan.files) await deps.writeTextFile(file.path, file.content);

    const totalMs = plan.durationSeconds * 1000;
    let lastWriteAt = deps.now().getTime();
    let lastProgress = 0;
    await deps.runFfmpeg({
      args: plan.args,
      signal,
      onProgress: outTimeMs => {
        const progress = Math.min(1, Math.max(0, outTimeMs / totalMs));
        tracker.latest = progress;
        const at = deps.now();
        if (at.getTime() - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
        if (progress - lastProgress < PROGRESS_MIN_DELTA) return;
        lastWriteAt = at.getTime();
        lastProgress = progress;
        statusWriter.progress({ state: 'running', progress, updatedAt: at.toISOString() });
      },
    });

    const bytes = await deps.fileSize(outputPath);
    if (bytes <= 0) throw new Error('ffmpeg produced an empty file');
    await deps.uploadOutput(outputPath, studioRenderOutputKey(job.id), signal);
    return { bytes, durationSeconds: plan.durationSeconds };
  } finally {
    await deps.removeWorkDir(workDir).catch(error => {
      deps.logger.warn('render work dir cleanup failed', { jobId: job.id, error: errorMessage(error) });
    });
  }
};

const enqueueStep = async (jobId: string, deps: RunRenderDeps): Promise<void> => {
  try {
    await deps.enqueueStep(jobId);
  } catch (error) {
    // Only a nudge: the engine's scheduled poll reads the status regardless.
    deps.logger.warn('render step enqueue failed', { jobId, error: errorMessage(error) });
  }
};

const isFresh = (status: StudioRenderStatus, nowMs: number): boolean =>
  nowMs - new Date(status.updatedAt).getTime() < RUNNING_STATUS_FRESH_MS;

export const runRender = async (
  jobId: string,
  deps: RunRenderDeps,
  options: { signal?: AbortSignal } = {}
): Promise<RunRenderOutcome> => {
  const job = await deps.loadJob(jobId);
  if (!job) return { outcome: 'skipped', reason: 'missing' };
  if (!isGenerationJobOfKind(job, 'render')) return { outcome: 'skipped', reason: 'not_render' };
  // The async handler enqueues this message before the engine records `running`, so a fast receive can see the submit in flight.
  if (job.state === 'pending' && job.submitAttemptedAt) return { outcome: 'not_yet_running' };
  // A cancelled, failed or already-stored job: the engine has moved on and nobody reads a new status.
  if (job.state !== 'running') return { outcome: 'skipped', reason: 'not_running' };
  if (job.cancelRequested) return { outcome: 'skipped', reason: 'cancel_requested' };

  // A redelivered message for an encode that already finished: only the wake-up may have been lost.
  const existing = await deps.readStatus(jobId);
  if (existing?.state === 'succeeded') {
    await enqueueStep(jobId, deps);
    return { outcome: 'already_succeeded' };
  }
  // A duplicate delivery while another task encodes: a second encode would overwrite that task's statuses.
  if (existing?.state === 'running' && isFresh(existing, deps.now().getTime())) {
    return { outcome: 'skipped', reason: 'in_progress' };
  }

  const statusWriter = createStatusWriter(jobId, deps);
  const nowMs = deps.now().getTime();
  const budgetMs = Math.min(
    STUDIO_RENDER_MAX_WALL_CLOCK_MS - DEADLINE_MARGIN_MS,
    new Date(job.deadlineAt).getTime() - nowMs - DEADLINE_MARGIN_MS
  );
  const fail = async (message: string): Promise<RunRenderOutcome> => {
    await statusWriter.final({ state: 'failed', message, updatedAt: deps.now().toISOString() });
    await enqueueStep(jobId, deps);
    return { outcome: 'failed', message };
  };
  if (budgetMs <= 0) return fail(TIMEOUT_FAILURE);

  const external = options.signal ?? new AbortController().signal;
  const cancel = new AbortController();
  const deadline = deadlineSignal(AbortSignal.any([external, cancel.signal]), budgetMs);
  const tracker: ProgressTracker = { latest: 0 };
  let stopHeartbeat = () => {};
  let rendered: { bytes: number; durationSeconds: number };
  try {
    await deps.writeStatus(jobId, { state: 'running', progress: 0, updatedAt: deps.now().toISOString() });
    stopHeartbeat = startHeartbeat(jobId, tracker, statusWriter, cancel, deps);
    rendered = await encode(job, deadline.signal, statusWriter, tracker, deps);
  } catch (error) {
    if (!deadline.timedOut() && cancel.signal.aborted) return { outcome: 'cancelled' };
    if (!deadline.timedOut() && external.aborted) {
      deps.logger.warn('render aborted by shutdown; leaving the message for redelivery', { jobId });
      let released = true;
      await statusWriter
        .final({ state: 'running', progress: tracker.latest, updatedAt: RELEASED_UPDATED_AT })
        .catch(releaseError => {
          released = false;
          deps.logger.warn('render status release failed', { jobId, error: errorMessage(releaseError) });
        });
      return { outcome: 'aborted', released };
    }
    const message = deadline.timedOut() ? TIMEOUT_FAILURE : userMessageOf(error);
    deps.logger.error('render failed', { jobId, message, error: errorMessage(error) });
    return fail(message);
  } finally {
    stopHeartbeat();
    deadline.dispose();
  }

  // Outside the try: a failed write of this status must not be reported as a failed render, since the MP4 exists.
  // It propagates instead, and the caller leaves the message for redelivery.
  const { bytes, durationSeconds } = rendered;
  await statusWriter.final({
    state: 'succeeded',
    s3Key: studioRenderOutputKey(jobId),
    bytes,
    durationSeconds,
    updatedAt: deps.now().toISOString(),
  });
  await enqueueStep(jobId, deps);
  deps.logger.info('render succeeded', { jobId, bytes, durationSeconds });
  return { outcome: 'succeeded', bytes, durationSeconds };
};
