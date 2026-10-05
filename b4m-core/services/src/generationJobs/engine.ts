import {
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobCommit,
  type GenerationJobState,
  type IGenerationJobDocument,
} from '@bike4mind/common';
import { MAX_STEP_ATTEMPTS, pollDelaySeconds } from './backoff';
import type { GenerationJobEngineDeps, GenerationJobHandler, StepOutcome, StepResult } from './types';

const isTerminal = (state: GenerationJobState) => TERMINAL_GENERATION_JOB_STATES.includes(state);

// SQS delayed delivery can land slightly early; dropping an on-time message would stall the job until the sweep.
const EARLY_DELIVERY_GRACE_MS = 2000;

const orphaned = (message: string): StepResult => ({ next: 'failed', error: { code: 'orphaned_submit', message } });

/**
 * Advances a job exactly one step per call. Safe under duplicate, delayed and reordered delivery:
 * the lease admits one worker at a time and every step ends in a single commit that releases it.
 * The kind's onTerminal (credit settlement) runs at most once via claimTerminalHandling.
 */
export class GenerationJobEngine {
  private readonly handlers: Map<string, GenerationJobHandler>;

  constructor(private readonly deps: GenerationJobEngineDeps) {
    this.handlers = new Map(deps.handlers.map(handler => [handler.kind, handler]));
  }

  async requestCancel(jobId: string): Promise<IGenerationJobDocument | null> {
    const job = await this.deps.repository.requestCancel(jobId);
    if (job) await this.deps.enqueue(job.id, 0);
    return job;
  }

  async step(jobId: string): Promise<StepOutcome> {
    const now = this.deps.now();
    const job = await this.deps.repository.acquireLease(jobId, now, new Date(now.getTime() + this.deps.leaseMs));
    if (!job) return 'skipped';
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      await this.deps.repository.commit(job.id, {});
      throw new Error(`no generation job handler registered for kind '${job.kind}'`);
    }

    if (isTerminal(job.state)) return this.finishTerminal(job, handler);

    // Checked before cancel and deadline so neither can suppress the orphan alarm.
    if (job.state === 'pending' && job.submitAttemptedAt) {
      this.deps.logger.error('generation_job_orphaned_submit', {
        jobId: job.id,
        kind: job.kind,
        submitAttemptedAt: job.submitAttemptedAt,
      });
      return this.apply(job, handler, orphaned('A previous submit attempt ended without a recorded provider job'));
    }

    // Storing means the provider already produced (and billed) the output, so a cancel no longer saves anything.
    if (job.cancelRequested && job.state !== 'storing') {
      if (job.state === 'running') await this.bestEffortCancel(job, handler);
      return this.toTerminal(job, handler, {
        state: 'cancelled',
        error: { code: 'cancelled', message: 'Cancelled by the user' },
      });
    }

    // An early or duplicate delivery would otherwise fork a second, permanent message chain for the job.
    if (job.nextPollAt && now.getTime() < new Date(job.nextPollAt).getTime() - EARLY_DELIVERY_GRACE_MS) {
      await this.deps.repository.commit(job.id, {});
      return 'skipped';
    }

    // Storing is exempt: the output is already paid for, and the store step stays bounded by MAX_STEP_ATTEMPTS.
    if (job.state !== 'storing' && now > job.deadlineAt) {
      if (job.state === 'running') await this.bestEffortCancel(job, handler);
      return this.toTerminal(job, handler, {
        state: 'failed',
        error: { code: 'provider_timeout', message: 'The provider did not finish in time' },
      });
    }

    const result = await this.runStep(job, handler);
    return this.apply(job, handler, result);
  }

  private async runStep(job: IGenerationJobDocument, handler: GenerationJobHandler): Promise<StepResult> {
    if (job.state === 'pending') return this.submit(job, handler);
    try {
      return job.state === 'running' ? await handler.poll(job) : await handler.store(job);
    } catch (error) {
      this.deps.logger.warn('generation job step threw; retrying', { jobId: job.id, state: job.state, error });
      return { next: 'retry', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // A provider job created by a submit we cannot see would bill without ever being polled, so any submit whose
  // outcome is unknown fails the job rather than risk a duplicate. See GenerationJobHandler.submit.
  private async submit(job: IGenerationJobDocument, handler: GenerationJobHandler): Promise<StepResult> {
    await this.deps.repository.markSubmitAttempted(job.id, this.deps.now());
    try {
      return await handler.submit(job);
    } catch (error) {
      this.deps.logger.error('generation_job_orphaned_submit', { jobId: job.id, kind: job.kind, error });
      return orphaned('The provider submit ended with an unknown outcome');
    }
  }

  private async apply(
    job: IGenerationJobDocument,
    handler: GenerationJobHandler,
    result: StepResult
  ): Promise<StepOutcome> {
    switch (result.next) {
      case 'running':
        return this.advance(
          job,
          { state: 'running', payload: result.payload, attempts: 0, pollCount: 0 },
          pollDelaySeconds(0)
        );
      case 'storing':
        return this.advance(job, { state: 'storing', payload: result.payload, attempts: 0, pollCount: 0 }, 0);
      case 'poll_again': {
        const pollCount = job.pollCount + 1;
        const progress = result.progress === undefined ? {} : { progress: result.progress };
        return this.advance(job, { pollCount, ...progress }, pollDelaySeconds(pollCount));
      }
      case 'retry': {
        const attempts = job.attempts + 1;
        if (attempts >= MAX_STEP_ATTEMPTS) {
          return this.toTerminal(job, handler, {
            state: 'failed',
            error: { code: 'provider_error', message: result.reason },
          });
        }
        // A retry from pending is a definitive submit rejection that created nothing, so resubmitting is safe.
        const clearSubmit = job.state === 'pending' ? { submitAttemptedAt: null } : {};
        return this.advance(job, { attempts, ...clearSubmit }, pollDelaySeconds(attempts - 1));
      }
      case 'succeeded':
        return this.toTerminal(job, handler, { state: 'succeeded', payload: result.payload, progress: 1 });
      case 'failed':
      case 'blocked':
        return this.toTerminal(job, handler, {
          state: result.next,
          error: result.error,
          rawProviderError: result.rawProviderError,
        });
    }
  }

  private async advance(
    job: IGenerationJobDocument,
    update: GenerationJobCommit,
    delaySeconds: number
  ): Promise<StepOutcome> {
    const nextPollAt = new Date(this.deps.now().getTime() + delaySeconds * 1000);
    const committed = await this.deps.repository.commit(job.id, { ...update, nextPollAt });
    if (!committed) return 'skipped';
    await this.deps.enqueue(job.id, delaySeconds);
    await this.safeNotify(committed);
    return 'advanced';
  }

  private async toTerminal(
    job: IGenerationJobDocument,
    handler: GenerationJobHandler,
    update: GenerationJobCommit
  ): Promise<StepOutcome> {
    const committed = await this.deps.repository.commit(job.id, { ...update, nextPollAt: null });
    if (!committed) return 'skipped';
    return this.finishTerminal(committed, handler);
  }

  // `job` must reflect the stored terminalHandlingClaimedAt (a leased or committed doc), which the stuck check reads.
  private async finishTerminal(job: IGenerationJobDocument, handler: GenerationJobHandler): Promise<StepOutcome> {
    const claimed = await this.deps.repository.claimTerminalHandling(job.id, this.deps.now());
    if (!claimed) {
      this.reportUnclaimable(job);
      await this.deps.repository.commit(job.id, {});
      return 'skipped';
    }
    await handler.onTerminal(job);
    await this.deps.repository.markTerminalHandled(job.id, this.deps.now());
    const released = await this.deps.repository.commit(job.id, {});
    await this.safeNotify(released ?? job);
    return 'terminal';
  }

  // A claim older than a lease means its run crashed mid-settlement; it is never retried (settling twice is worse
  // than not at all), so it is alarmed for manual repair. A fresher claim is a live concurrent run.
  private reportUnclaimable(job: IGenerationJobDocument) {
    const claimedAt = job.terminalHandlingClaimedAt;
    const stuck = !!claimedAt && this.deps.now().getTime() - new Date(claimedAt).getTime() > this.deps.leaseMs;
    if (stuck) {
      this.deps.logger.error('generation_job_terminal_handling_stuck', { jobId: job.id, kind: job.kind, claimedAt });
      return;
    }
    this.deps.logger.debug('generation job terminal handling claimed by a concurrent run', { jobId: job.id });
  }

  private async bestEffortCancel(job: IGenerationJobDocument, handler: GenerationJobHandler) {
    try {
      await handler.cancelAtProvider(job);
    } catch (error) {
      this.deps.logger.warn('provider cancel failed; the provider job may still complete and be discarded', {
        jobId: job.id,
        error,
      });
    }
  }

  private async safeNotify(job: IGenerationJobDocument | null) {
    if (!job) return;
    try {
      await this.deps.notify(job);
    } catch (error) {
      this.deps.logger.warn('generation job notify failed', { jobId: job.id, error });
    }
  }
}
