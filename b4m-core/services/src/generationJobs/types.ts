import type {
  GenerationJobError,
  GenerationJobKind,
  GenerationJobPayloads,
  IGenerationJobDocument,
  IGenerationJobDocumentOf,
  IGenerationJobRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/** A step's outcome; a payload it carries is the payload of the job's own kind. */
export type StepResult<K extends GenerationJobKind = GenerationJobKind> =
  | { next: 'running'; payload: GenerationJobPayloads[K] } // submit accepted
  | { next: 'poll_again'; progress?: number }
  | { next: 'storing'; payload: GenerationJobPayloads[K] } // provider finished
  | { next: 'succeeded'; payload: GenerationJobPayloads[K] }
  | { next: 'failed'; error: GenerationJobError; rawProviderError?: unknown }
  | { next: 'blocked'; error: GenerationJobError; rawProviderError?: unknown; payload?: GenerationJobPayloads[K] }
  | { next: 'retry'; reason: string }; // transient; same state, backoff

/**
 * Per-step context. `signal` aborts before the step's lease runs out, so a hung provider call fails the step
 * (as a transport error) instead of outliving the lease and racing the worker that takes the job over.
 */
export type GenerationJobStepContext = { signal: AbortSignal };

/** One kind's steps; each method only ever receives a job of that kind (the engine dispatches by `job.kind`). */
export type GenerationJobHandler<K extends GenerationJobKind = GenerationJobKind> = {
  kind: K;
  /**
   * Throwing means the outcome is unknown (the provider may have created a job), so the engine fails it as
   * orphaned_submit. Return `{ next: 'retry' }` for anything that created nothing (a failure before the provider
   * call, or a definitive rejection); it is resubmitted.
   */
  submit(job: IGenerationJobDocumentOf<K>, context: GenerationJobStepContext): Promise<StepResult<K>>;
  poll(job: IGenerationJobDocumentOf<K>, context: GenerationJobStepContext): Promise<StepResult<K>>;
  store(job: IGenerationJobDocumentOf<K>, context: GenerationJobStepContext): Promise<StepResult<K>>;
  cancelAtProvider(job: IGenerationJobDocumentOf<K>, context: GenerationJobStepContext): Promise<void>;
  /** Must tolerate being the only call: the engine guarantees at most once, not exactly once. */
  onTerminal(job: IGenerationJobDocumentOf<K>): Promise<void>;
};

/** A handler for any one kind, as the engine accepts them. */
export type AnyGenerationJobHandler = { [K in GenerationJobKind]: GenerationJobHandler<K> }[GenerationJobKind];

export type GenerationJobEngineDeps = {
  repository: IGenerationJobRepository;
  handlers: readonly AnyGenerationJobHandler[];
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  notify(job: IGenerationJobDocument): Promise<void>;
  now(): Date;
  logger: Logger;
  leaseMs: number;
};

export type StepOutcome = 'skipped' | 'advanced' | 'terminal';
