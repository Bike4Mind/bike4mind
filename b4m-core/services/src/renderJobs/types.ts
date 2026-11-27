import type {
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
  IStudioCompositionDocument,
  StorageLimitErrorInfo,
  StudioRenderPricing,
  StudioRenderStatus,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import type { GenerationJobEngine } from '../generationJobs/engine';
import type { CreateGenerationJobDeps } from '../generationJobs/createJob';
import type { VideoJobDeps } from '../videoJobs/types';

export type RenderJob = IGenerationJobDocumentOf<'render'>;

/** The engine side of a render: hand the job to the render worker, read its report, keep its MP4. */
export type RenderJobDeps = {
  repository: IGenerationJobRepository;
  credits: CreditHoldAdapters;
  /** Sends the job to the render queue. A throw means nothing was queued, so the submit retries. */
  dispatchRender(jobId: string): Promise<void>;
  /** The worker's latest report, or null when it has not picked the job up yet. */
  readRenderStatus(jobId: string): Promise<StudioRenderStatus | null>;
  /** The worker's finished encode, from the generated bucket. */
  fetchRenderedOutput(s3Key: string, signal: AbortSignal): Promise<Buffer>;
  saveToFiles: VideoJobDeps['saveToFiles'];
  saveToGeneratedBucket: VideoJobDeps['saveToGeneratedBucket'];
  now(): Date;
  logger: Logger;
};

export type CreateRenderJobsDeps = Pick<CreateGenerationJobDeps, 'repository' | 'credits' | 'enqueue' | 'logger'> & {
  engine: Pick<GenerationJobEngine, 'failBeforeStart'>;
  getSettings(): Promise<{ enforceCredits: boolean; pricing: StudioRenderPricing }>;
  /** True on a deployment with no paid plans (self-host), where exports are open to every user. */
  planlessDeployment: boolean;
  /** Owner-only, like every composition read: someone else's Production answers as missing. */
  findComposition(id: string, userId: string): Promise<IStudioCompositionDocument | null>;
  /** The files among `fileIds` the user can read now, by id, with their MIME type. */
  findReadableFiles(fileIds: string[], userId: string): Promise<Map<string, string>>;
  checkStorageFor(userId: string, bytes: number): Promise<StorageLimitErrorInfo | undefined>;
  now(): Date;
};

export type CreateRenderJobsInput = {
  user: { id: string; organizationId: string | null; isAdmin?: boolean | null; tags?: string[] | null };
  /** The requester's entitlement keys; read only when the free-tier gate applies (exports are paid-plan only). */
  getEntitlements: () => Promise<string[]>;
  compositionId: string;
  /** Ids from the timeline's `outputs`; one job each. Untrusted. */
  outputIds: string[];
};

export type CreateRenderJobsRefusalCode =
  | 'composition_not_found'
  | 'invalid_outputs'
  | 'invalid_timeline'
  | 'empty_timeline'
  | 'input_file_not_found'
  | 'insufficient_credits'
  | 'storage_quota_exceeded';

export type CreateRenderJobsResult =
  | { ok: true; groupId: string; jobs: RenderJob[] }
  | { ok: false; status: number; code: CreateRenderJobsRefusalCode; message: string; storage?: StorageLimitErrorInfo };

// A generous H.264 1080p bitrate (about 8 Mbps video plus audio), for the create-time storage check only.
export const RENDER_OUTPUT_BYTES_PER_SECOND_ESTIMATE = 1_100_000;
