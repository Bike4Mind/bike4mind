import type {
  GeneratedAssetLineageEntry,
  GeneratedAssetMetadata,
  IGenerationJobDocument,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { SaveGeneratedAssetResult } from '../generatedAssets';

// Fresh budget for the bucket fallback when the step signal already fired; must fit inside the engine's commit
// margin (STEP_COMMIT_MARGIN_MS), like its FAILURE_CANCEL_BUDGET_MS.
export const FALLBACK_SAVE_BUDGET_MS = 10_000;

/** What our own post-generation scan decided about an output. */
export type OutputModerationVerdict = { blocked: false } | { blocked: true; reason: string };

/** Where the bytes landed; a kind's job output spreads this next to its own fields. */
export type StoredOutputLocation = { location: 'files'; s3Key: string; fileId: string } | { location: 'generated'; s3Key: string };

export type StoredOutput = { stored: true; location: StoredOutputLocation };
export type StoreOutputResult = StoredOutput | { stored: false; reason: string };

export type StoreOutputDeps = {
  /**
   * saveGeneratedAsset bound to the user's files, idempotent per `generation.jobId` (a store step can run twice for
   * one job). An abort of `signal` must reject rather than report an ordinary save failure.
   */
  saveToFiles(params: {
    userId: string;
    bytes: Buffer;
    contentType: string;
    generation: GeneratedAssetMetadata & { jobId: string };
    derivedFrom?: GeneratedAssetLineageEntry[];
    sessionId?: string;
    questId?: string;
    signal: AbortSignal;
  }): Promise<SaveGeneratedAssetResult>;
  saveToGeneratedBucket(params: {
    key: string;
    bytes: Buffer;
    contentType: string;
    signal: AbortSignal;
  }): Promise<{ s3Key: string }>;
  logger: Logger;
};

export type StoreOutputParams = {
  job: Pick<IGenerationJobDocument, 'id' | 'ownerId' | 'requestedBy'>;
  /** Names the output in log lines: `${noun} saved outside Files`. */
  noun: string;
  bytes: Buffer;
  contentType: string;
  generation: GeneratedAssetMetadata & { jobId: string };
  /** Input files the output was made from; an empty list records no lineage. */
  derivedFrom?: GeneratedAssetLineageEntry[];
  sessionId?: string;
  questId?: string;
  /** The fallback key is `${bucketFolder}/${ownerId}/${jobId}.${extension}`. */
  bucketFolder: string;
  extension: string;
  /**
   * What a rejecting Files save does. `fallback` keeps the output in the generated bucket (a sync submit cannot
   * retry); `rethrow` fails the step so the engine retries it, for a retryable async store step.
   */
  onFilesError: 'fallback' | 'rethrow';
  /** Runs before anything is stored; a throw (the scan could not run) fails closed and nothing is kept. */
  moderate?: () => Promise<OutputModerationVerdict>;
  signal: AbortSignal;
};

/**
 * Saves a generated output to the user's Files with its `derivedFrom` lineage, falling back to the generated bucket
 * when Files refuses it (e.g. over quota). Shared by every generation-job kind's store step.
 */
export function storeGeneratedOutput(
  params: StoreOutputParams & { moderate: NonNullable<StoreOutputParams['moderate']> },
  deps: StoreOutputDeps
): Promise<StoreOutputResult>;
/** Without a moderation hook nothing can refuse the output, so it is stored or the call throws. */
export function storeGeneratedOutput(
  params: Omit<StoreOutputParams, 'moderate'>,
  deps: StoreOutputDeps
): Promise<StoredOutput>;
export async function storeGeneratedOutput(params: StoreOutputParams, deps: StoreOutputDeps): Promise<StoreOutputResult> {
  const { job, noun, bytes, contentType, signal } = params;
  if (params.moderate) {
    const verdict = await params.moderate();
    if (verdict.blocked) return { stored: false, reason: verdict.reason };
  }

  const saved = await saveToFiles(params, deps);
  if (saved) return { stored: true, location: saved };

  // An aborted step signal would reject the fallback too, losing an output the provider already billed.
  const fallbackSignal = signal.aborted ? AbortSignal.timeout(FALLBACK_SAVE_BUDGET_MS) : signal;
  const key = `${params.bucketFolder}/${job.ownerId}/${job.id}.${params.extension}`;
  try {
    const { s3Key } = await deps.saveToGeneratedBucket({ key, bytes, contentType, signal: fallbackSignal });
    return { stored: true, location: { location: 'generated', s3Key } };
  } catch (error) {
    // Generated and billed but cannot be kept: the caller's step fails (sync) or retries (async) on this throw.
    deps.logger.error(`${noun}_job_output_unsaved`, { jobId: job.id, bytes: bytes.byteLength, error });
    throw error;
  }
}

/** The Files location, or undefined when the output should go to the bucket instead. */
async function saveToFiles(
  params: StoreOutputParams,
  deps: StoreOutputDeps
): Promise<StoredOutputLocation | undefined> {
  const { job, noun, bytes, contentType, generation, derivedFrom, sessionId, questId, signal } = params;
  try {
    const files = await deps.saveToFiles({
      userId: job.requestedBy,
      bytes,
      contentType,
      generation,
      ...(derivedFrom && derivedFrom.length > 0 && { derivedFrom }),
      // Truthy, not !== undefined: a stored job can carry a null id.
      ...(sessionId && { sessionId }),
      ...(questId && { questId }),
      signal,
    });
    if (files.saved) return { location: 'files', s3Key: files.s3Key, fileId: files.fileId };
    deps.logger.warn(`${noun} saved outside Files`, { jobId: job.id, reason: files.reason });
    return undefined;
  } catch (error) {
    if (params.onFilesError === 'rethrow') throw error;
    deps.logger.warn(`${noun} save to Files threw; saving outside Files`, { jobId: job.id, error });
    return undefined;
  }
}
