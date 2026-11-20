import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  SCENE_INPUT_MEDIA,
  SCENE_MAX_INPUT_BYTES,
  SCENE_MAX_VIDEO_SECONDS,
  type ComposeJobPayload,
  type GeneratedAssetLineageEntry,
  type GeneratedAssetLineageRole,
  type GenerationJobErrorCode,
  type SceneInputSlot,
} from '@bike4mind/common';
import { releaseJobHold } from '../generationJobs/settlement';
import { storeGeneratedOutput } from '../generationJobs/storeOutput';
import type { GenerationJobHandler, GenerationJobStepContext, StepResult } from '../generationJobs/types';
import { buildSceneComposeArgs, parseFfmpegProbe, probeArgs, type MediaProbe } from './composeArgs';
import { isSceneSlotMedia, sceneInputSlots } from './createSceneCompositionJob';
import {
  SCENE_FFMPEG_TIMEOUT_MS,
  SCENE_MAX_OUTPUT_BYTES,
  type SceneInputFile,
  type SceneJob,
  type SceneJobDeps,
} from './types';

const SCENE_CONTENT_TYPE = 'video/mp4';
const PROBE_TIMEOUT_MS = 30_000;
// ffmpeg's stderr can echo a whole stream summary; the job's error message keeps only its tail.
const MAX_ERROR_DETAIL_CHARS = 500;
const DEFAULT_SCENE_TITLE = 'Scene';

type SceneStepResult = StepResult<'compose'>;

const LINEAGE_ROLE: Record<SceneInputSlot, GeneratedAssetLineageRole> = {
  video: 'scene_video',
  audio: 'scene_audio',
  cover: 'scene_cover',
};

/** A refusal the render cannot recover from by retrying: the inputs themselves are the problem. */
export class SceneInputError extends Error {
  constructor(
    message: string,
    readonly code: Extract<GenerationJobErrorCode, 'unsupported_input' | 'provider_error' | 'output_too_large'>
  ) {
    super(message);
    this.name = 'SceneInputError';
  }
}

const fail = (code: GenerationJobErrorCode, message: string): SceneStepResult => ({
  next: 'failed',
  error: { code, message },
});

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const stderrTail = (stderr: string): string => {
  const trimmed = stderr.trim();
  return trimmed.length <= MAX_ERROR_DETAIL_CHARS ? trimmed : `...${trimmed.slice(-MAX_ERROR_DETAIL_CHARS)}`;
};

type LoadedInput = { slot: SceneInputSlot; fileId: string; path: string; file: SceneInputFile };

/**
 * The compose kind on the generic GenerationJobEngine. Our own worker renders the Scene with ffmpeg in one sync
 * submit step: download the inputs to a private temp dir, probe them, mux, store, and remove the dir. Nothing is
 * billed, so every infrastructure failure (a download, the ffmpeg process, the store) retries; only the inputs
 * being unusable fails the job.
 */
export function createSceneJobHandler(deps: SceneJobDeps): GenerationJobHandler<'compose'> {
  const probe = async (path: string, signal: AbortSignal): Promise<MediaProbe> => {
    const { stderr } = await deps.ffmpeg.run(probeArgs(path), { signal, timeoutMs: PROBE_TIMEOUT_MS });
    return parseFfmpegProbe(stderr);
  };

  const loadInputs = async (job: SceneJob, workDir: string, signal: AbortSignal): Promise<LoadedInput[]> => {
    const slots = sceneInputSlots(job.payload.request);
    const files: LoadedInput[] = [];
    for (const { slot, fileId } of slots) {
      // Re-checked here: a file can be deleted, rescanned or replaced between create and render.
      const file = await deps.loadInputFile(job.requestedBy, fileId);
      if (!file) throw new SceneInputError(`The ${slot} file is no longer available`, 'unsupported_input');
      if (!isSceneSlotMedia(slot, file)) {
        throw new SceneInputError(
          `The ${slot} file must be ${SCENE_INPUT_MEDIA[slot].slice(0, -1)} media, not ${file.mimeType}`,
          'unsupported_input'
        );
      }
      files.push({ slot, fileId, path: `${workDir}/${slot}`, file });
    }
    const totalBytes = files.reduce((sum, { file }) => sum + file.bytes, 0);
    if (totalBytes > SCENE_MAX_INPUT_BYTES) {
      throw new SceneInputError(`The input files total more than ${SCENE_MAX_INPUT_BYTES} bytes`, 'unsupported_input');
    }
    let downloadedBytes = 0;
    for (const { file, path } of files) {
      const { bytes } = await deps.downloadInputFile({
        s3Key: file.s3Key,
        destinationPath: path,
        maxBytes: SCENE_MAX_INPUT_BYTES - downloadedBytes,
        signal,
      });
      downloadedBytes += bytes;
    }
    return files;
  };

  const measure = async (paths: { video: string; audio: string; cover?: string }, signal: AbortSignal) => {
    const video = await probe(paths.video, signal);
    if (!video.hasVideo || video.durationSeconds === null) {
      throw new SceneInputError('The video file has no readable video stream', 'unsupported_input');
    }
    if (video.durationSeconds > SCENE_MAX_VIDEO_SECONDS) {
      throw new SceneInputError(
        `The video runs ${Math.round(video.durationSeconds)} seconds; the limit is ${SCENE_MAX_VIDEO_SECONDS}`,
        'unsupported_input'
      );
    }
    const audio = await probe(paths.audio, signal);
    if (!audio.hasAudio || audio.durationSeconds === null) {
      throw new SceneInputError('The audio file has no readable audio stream', 'unsupported_input');
    }
    if (paths.cover && !(await probe(paths.cover, signal)).hasVideo) {
      throw new SceneInputError('The cover file is not a readable image', 'unsupported_input');
    }
    return { videoSeconds: video.durationSeconds, audioSeconds: audio.durationSeconds };
  };

  const render = async (job: SceneJob, workDir: string, signal: AbortSignal) => {
    const { request } = job.payload;
    const inputs = await loadInputs(job, workDir, signal);
    const paths = {
      video: `${workDir}/video`,
      audio: `${workDir}/audio`,
      ...(request.coverFileId && { cover: `${workDir}/cover` }),
    };
    const { videoSeconds, audioSeconds } = await measure(paths, signal);
    const outputPath = `${workDir}/scene.mp4`;
    const args = buildSceneComposeArgs({
      videoPath: paths.video,
      audioPath: paths.audio,
      ...(paths.cover && { coverPath: paths.cover }),
      outputPath,
      videoSeconds,
      audioSeconds,
      audio: request.audio,
      ...(request.title && { title: request.title }),
    });
    const { exitCode, stderr } = await deps.ffmpeg.run(args, { signal, timeoutMs: SCENE_FFMPEG_TIMEOUT_MS });
    if (exitCode !== 0) {
      // The inputs probed as valid media, so a failed mux is most likely a stream the MP4 container cannot carry.
      throw new SceneInputError(`The Scene could not be rendered: ${stderrTail(stderr)}`, 'unsupported_input');
    }
    const { size } = await stat(outputPath);
    if (size > SCENE_MAX_OUTPUT_BYTES) {
      throw new SceneInputError(
        `The rendered Scene is ${size} bytes; the limit is ${SCENE_MAX_OUTPUT_BYTES}`,
        'output_too_large'
      );
    }
    const rendered = await probe(outputPath, signal);
    return {
      bytes: await readFile(outputPath),
      durationSeconds: rendered.durationSeconds ?? videoSeconds,
      derivedFrom: inputs.map(({ slot, fileId }): GeneratedAssetLineageEntry => ({
        fileId,
        jobId: job.id,
        role: LINEAGE_ROLE[slot],
      })),
    };
  };

  const compose = async (job: SceneJob, { signal }: GenerationJobStepContext): Promise<SceneStepResult> => {
    // A template literal, not path.join: a runtime-valued join makes the bundler's file tracer glob the app dir.
    const workDir = await mkdtemp(`${tmpdir()}/b4m-scene-`);
    try {
      const { bytes, durationSeconds, derivedFrom } = await render(job, workDir, signal);
      const { request } = job.payload;
      const { location, filesSkipReason } = await storeGeneratedOutput(
        {
          job,
          noun: 'scene',
          bytes,
          contentType: SCENE_CONTENT_TYPE,
          generation: {
            generator: 'scene',
            provider: 'ffmpeg',
            jobId: job.id,
            prompt: request.title ?? DEFAULT_SCENE_TITLE,
            durationSeconds,
            request,
          },
          derivedFrom,
          bucketFolder: 'generated-video',
          extension: 'mp4',
          // A save that throws retries the whole render (nothing is billed). A refusal (size limit, quota) does not
          // throw: the Scene is kept in the generated bucket and filesSkipReason says why.
          onFilesError: 'rethrow',
          signal,
        },
        deps
      );
      const payload: ComposeJobPayload = {
        ...job.payload,
        output: {
          ...location,
          contentType: SCENE_CONTENT_TYPE,
          bytes: bytes.byteLength,
          durationSeconds,
          ...(filesSkipReason && { filesSkipReason }),
        },
      };
      return { next: 'succeeded', payload };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch((error: unknown) =>
        deps.logger.warn('scene job temp dir cleanup failed', { jobId: job.id, workDir, error })
      );
    }
  };

  const unreachable = (job: SceneJob, step: string): SceneStepResult => {
    deps.logger.error('scene_job_unexpected_step', { jobId: job.id, state: job.state, step });
    return fail('provider_error', `scene jobs finish in submit; ${step} is never reached`);
  };

  return {
    kind: 'compose',
    submitMode: 'sync',

    async submit(job, context) {
      try {
        return await compose(job, context);
      } catch (error) {
        if (error instanceof SceneInputError) return fail(error.code, error.message);
        // Nothing billed and nothing half-stored (the Files save is idempotent per job), so rendering again is safe.
        deps.logger.warn('scene job render failed; retrying', { jobId: job.id, message: messageOf(error) });
        return { next: 'retry', reason: messageOf(error) };
      }
    },

    async poll(job) {
      return unreachable(job, 'poll');
    },

    async store(job) {
      return unreachable(job, 'store');
    },

    // The render is a local process inside the submit step; there is no remote job to stop.
    async cancelAtProvider() {},

    // No hold is taken in v1, so this only records a zero settlement; it would return a hold were one ever taken.
    async onTerminal(job) {
      await releaseJobHold(job, deps);
    },
  };
}
