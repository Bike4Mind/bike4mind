import type {
  GenerationJobError,
  GenerationJobKind,
  IGenerationJob,
  IGenerationJobDocument,
  IGenerationJobRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

export type StepResult =
  | { next: 'running'; payload: IGenerationJob['payload'] } // submit accepted
  | { next: 'poll_again'; progress?: number }
  | { next: 'storing'; payload: IGenerationJob['payload'] } // provider finished
  | { next: 'succeeded'; payload: IGenerationJob['payload'] }
  | { next: 'failed'; error: GenerationJobError; rawProviderError?: unknown }
  | { next: 'blocked'; error: GenerationJobError; rawProviderError?: unknown }
  | { next: 'retry'; reason: string }; // transient; same state, backoff

/**
 * Per-step context. `signal` aborts before the step's lease runs out, so a hung provider call fails the step
 * (as a transport error) instead of outliving the lease and racing the worker that takes the job over.
 */
export type GenerationJobStepContext = { signal: AbortSignal };

export type GenerationJobHandler = {
  kind: GenerationJobKind;
  /**
   * Throwing means the outcome is unknown (the provider may have created a job), so the engine fails it as
   * orphaned_submit. Return `{ next: 'retry' }` only for a definitive rejection that created nothing; it is resubmitted.
   */
  submit(job: IGenerationJobDocument, context: GenerationJobStepContext): Promise<StepResult>;
  poll(job: IGenerationJobDocument, context: GenerationJobStepContext): Promise<StepResult>;
  store(job: IGenerationJobDocument, context: GenerationJobStepContext): Promise<StepResult>;
  cancelAtProvider(job: IGenerationJobDocument, context: GenerationJobStepContext): Promise<void>;
  /** Must tolerate being the only call: the engine guarantees at most once, not exactly once. */
  onTerminal(job: IGenerationJobDocument): Promise<void>;
};

export type GenerationJobEngineDeps = {
  repository: IGenerationJobRepository;
  handlers: readonly GenerationJobHandler[];
  enqueue(jobId: string, delaySeconds: number): Promise<void>;
  notify(job: IGenerationJobDocument): Promise<void>;
  now(): Date;
  logger: Logger;
  leaseMs: number;
};

export type StepOutcome = 'skipped' | 'advanced' | 'terminal';
