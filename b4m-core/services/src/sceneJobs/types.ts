import type {
  GenerationJobSource,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  SceneInputSlot,
  StorageLimitErrorInfo,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { StoreOutputDeps } from '../generationJobs/storeOutput';

// Stamped on the job as deadlineAt at create; the engine fails a pending job past it.
export const SCENE_JOB_MAX_WALL_CLOCK_MS = 15 * 60_000;

/**
 * The most one ffmpeg run may take. Must stay inside a step's budget (the engine's lease, which outlives the worker
 * timeout in infra/queues.ts) together with the downloads and the store: a 5-minute video is stream-copied, so only
 * the soundtrack is encoded and a real render takes seconds.
 */
export const SCENE_FFMPEG_TIMEOUT_MS = 3 * 60_000;

/** A rendered Scene over this is refused rather than held in memory for the store step. */
export const SCENE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export type SceneJob = IGenerationJobDocumentOf<'compose'>;

/** One of the requester's own files, readable now (not deleted, through the upload scan). */
export type SceneInputFile = { s3Key: string; mimeType: string; bytes: number };

/** The result of one ffmpeg run. A non-zero exit is a value; a spawn failure, timeout or abort rejects. */
export type FfmpegRunResult = { exitCode: number; stderr: string };

export type FfmpegRunner = {
  run(args: readonly string[], options: { signal: AbortSignal; timeoutMs: number }): Promise<FfmpegRunResult>;
};

export type SceneJobDeps = StoreOutputDeps & {
  repository: IGenerationJobRepository;
  /**
   * The requester's own file by id, or null when it is not theirs, is deleted, has no stored bytes or is not
   * through the upload scan. Owner-only on purpose, as for video inputs: the bytes are re-published in a new file.
   */
  loadInputFile(userId: string, fileId: string): Promise<SceneInputFile | null>;
  /**
   * Streams a stored input to a local path and reports the bytes written. Rejects with a SceneInputError once the
   * stream passes `maxBytes`, the room left in the Scene's total input budget.
   */
  downloadInputFile(params: {
    s3Key: string;
    destinationPath: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<{ bytes: number }>;
  ffmpeg: FfmpegRunner;
  /** Scenes hold no credits in v1; settlement only records 0 (and would return a hold, were one ever taken). */
  credits: CreditHoldAdapters;
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  now(): Date;
  logger: Logger;
};

export type CreateSceneCompositionJobDeps = Pick<
  SceneJobDeps,
  'repository' | 'loadInputFile' | 'credits' | 'enqueue' | 'now' | 'logger'
> & {
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  /** The refusal detail when the user's Files quota lacks room for `bytes` more; undefined when there is room. */
  checkStorageFor(userId: string, bytes: number): Promise<StorageLimitErrorInfo | undefined>;
};

export type CreateSceneCompositionJobInput = {
  user: { id: string; organizationId: string | null };
  /** Untrusted: parsed and validated by createSceneCompositionJob. */
  request: unknown;
  source: GenerationJobSource;
  /** The UserApiKey that authenticated the request, kept on the job like every other kind. */
  apiKeyId?: string;
  idempotencyKey?: string;
};

export type CreateSceneCompositionJobResult =
  | { ok: true; job: SceneJob; created: boolean }
  | {
      ok: false;
      status: 404;
      code: 'input_file_not_found';
      message: string;
      slot: SceneInputSlot;
    }
  | {
      ok: false;
      status: 422;
      code: 'invalid_request' | 'unsupported_input' | 'limit_exceeded' | 'idempotency_key_reused';
      message: string;
    }
  | { ok: false; status: 400; code: 'storage_quota_exceeded'; message: string; storage: StorageLimitErrorInfo };
