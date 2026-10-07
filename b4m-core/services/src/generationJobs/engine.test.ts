import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IGenerationJob } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from './__test__/inMemoryGenerationJobRepository';
import { MAX_STEP_ATTEMPTS } from './backoff';
import { GenerationJobEngine } from './engine';
import type { GenerationJobHandler, StepResult } from './types';

const payload = {
  request: {
    model: 'test-video',
    mode: 'text_to_video',
    prompt: 'p',
    durationSeconds: 4,
    aspectRatio: '16:9',
    resolution: '720p',
  },
  providerId: 'test',
} as IGenerationJob['payload'];

const LEASE_MS = 330_000;

const setup = () => {
  let clock = new Date('2026-10-06T00:00:00Z');
  const now = () => clock;
  const repository = createInMemoryGenerationJobRepository({ now });
  const enqueue = vi.fn(async (_jobId: string, _delay: number) => undefined);
  const notify = vi.fn(async () => undefined);
  const results: Record<'submit' | 'poll' | 'store', Array<StepResult | Error>> = { submit: [], poll: [], store: [] };
  const take = (step: 'submit' | 'poll' | 'store') => async () => {
    const next = results[step].shift();
    if (!next) throw new Error(`no scripted ${step} result`);
    if (next instanceof Error) throw next;
    return next;
  };
  const handler: GenerationJobHandler = {
    kind: 'video',
    submit: vi.fn(take('submit')),
    poll: vi.fn(take('poll')),
    store: vi.fn(take('store')),
    cancelAtProvider: vi.fn(async () => undefined),
    onTerminal: vi.fn(async () => undefined),
  };
  const logger = new Logger({ metadata: { test: 'engine' } });
  const engine = new GenerationJobEngine({
    repository,
    handlers: [handler],
    enqueue,
    notify,
    now,
    logger,
    leaseMs: LEASE_MS,
  });
  const create = (overrides: Partial<IGenerationJob> = {}) =>
    repository.createJob({
      kind: 'video',
      ownerType: CreditHolderType.User,
      ownerId: 'u1',
      requestedBy: 'u1',
      source: 'studio',
      state: 'pending',
      payload,
      pollCount: 0,
      attempts: 0,
      cancelRequested: false,
      deadlineAt: new Date(clock.getTime() + 20 * 60_000),
      creditHold: null,
      ...overrides,
    });
  return {
    engine,
    repository,
    handler,
    enqueue,
    notify,
    results,
    create,
    logger,
    now,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
  };
};

const errorLogsNamed = (spy: ReturnType<typeof vi.spyOn>, name: string) =>
  spy.mock.calls.filter(call => call[0] === name);

describe('GenerationJobEngine', () => {
  it('runs submit -> poll -> store -> succeeded, one step per message, then settles once', async () => {
    const t = setup();
    const job = await t.create();
    t.results.submit.push({ next: 'running', payload: { ...payload, providerHandle: { provider: 'test', data: {} } } });
    t.results.poll.push({ next: 'poll_again', progress: 0.5 }, { next: 'storing', payload });
    t.results.store.push({ next: 'succeeded', payload });

    expect(await t.engine.step(job.id)).toBe('advanced'); // submit
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 5);
    t.advance(5_000); // each message is delivered when its SQS delay elapses
    expect(await t.engine.step(job.id)).toBe('advanced'); // poll: still running
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 10);
    t.advance(10_000);
    expect(await t.engine.step(job.id)).toBe('advanced'); // poll: done
    expect(await t.engine.step(job.id)).toBe('terminal'); // store

    const final = t.repository.jobs.get(job.id)!;
    expect(final.state).toBe('succeeded');
    expect(final.terminalHandledAt).toBeTruthy();
    expect(final.leaseUntil).toBeNull();
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalled();
  });

  it('duplicate message while leased is a no-op', async () => {
    const t = setup();
    const job = await t.create();
    await t.repository.acquireLease(job.id, new Date('2026-10-06T00:00:00Z'), new Date('2026-10-06T00:05:30Z'));
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.handler.submit).not.toHaveBeenCalled();
  });

  it('marks the submit attempt before calling the provider', async () => {
    const t = setup();
    const job = await t.create();
    let observedSubmitAttemptedAt: Date | null | undefined;
    vi.mocked(t.handler.submit).mockImplementationOnce(async () => {
      observedSubmitAttemptedAt = t.repository.jobs.get(job.id)!.submitAttemptedAt;
      return { next: 'running', payload } satisfies StepResult;
    });
    await t.engine.step(job.id);
    expect(observedSubmitAttemptedAt).toEqual(t.now());
    expect(t.repository.jobs.get(job.id)!.state).toBe('running');
  });

  it('an orphaned submit is alarmed and settled as orphaned_submit even when a cancel was requested', async () => {
    const t = setup();
    const errorSpy = vi.spyOn(t.logger, 'error');
    const job = await t.create({ submitAttemptedAt: new Date('2026-10-05T23:59:00Z'), cancelRequested: true });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('orphaned_submit');
    expect(errorLogsNamed(errorSpy, 'generation_job_orphaned_submit')).toHaveLength(1);
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('a message delivered well before nextPollAt is dropped without forking a second chain', async () => {
    const t = setup();
    const job = await t.create({ state: 'running', pollCount: 2, nextPollAt: new Date(t.now().getTime() + 60_000) });
    expect(await t.engine.step(job.id)).toBe('skipped');
    const after = t.repository.jobs.get(job.id)!;
    expect(after.state).toBe('running');
    expect(after.pollCount).toBe(2);
    expect(after.leaseUntil).toBeNull();
    expect(t.handler.poll).not.toHaveBeenCalled();
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it('a message delivered within the early-delivery grace proceeds normally', async () => {
    const t = setup();
    const job = await t.create({ state: 'running', nextPollAt: new Date(t.now().getTime() + 1_500) });
    t.results.poll.push({ next: 'poll_again' });
    expect(await t.engine.step(job.id)).toBe('advanced');
    expect(t.handler.poll).toHaveBeenCalledTimes(1);
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 10);
  });

  it('does not enqueue when the advancing commit finds the job gone', async () => {
    const t = setup();
    const job = await t.create();
    vi.mocked(t.handler.submit).mockImplementationOnce(async () => {
      t.repository.jobs.delete(job.id);
      return { next: 'running', payload } satisfies StepResult;
    });
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.enqueue).not.toHaveBeenCalled();
  });

  it('a pending job with a submit attempt already recorded fails as orphaned_submit without resubmitting', async () => {
    const t = setup();
    const job = await t.create({ submitAttemptedAt: new Date('2026-10-05T23:59:00Z') });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.handler.submit).not.toHaveBeenCalled();
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('orphaned_submit');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it('a submit with an unknown outcome fails as orphaned_submit immediately', async () => {
    const t = setup();
    const errorSpy = vi.spyOn(t.logger, 'error');
    const job = await t.create();
    t.results.submit.push(new Error('socket hang up'));
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('orphaned_submit');
    expect(errorLogsNamed(errorSpy, 'generation_job_orphaned_submit')).toHaveLength(1);
  });

  it('a definitive submit rejection clears the attempt and retries with backoff', async () => {
    const t = setup();
    const job = await t.create();
    t.results.submit.push({ next: 'retry', reason: 'HTTP 429' });
    expect(await t.engine.step(job.id)).toBe('advanced');
    const after = t.repository.jobs.get(job.id)!;
    expect(after.state).toBe('pending');
    expect(after.submitAttemptedAt).toBeNull();
    expect(after.attempts).toBe(1);
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 5);

    t.advance(5_000);
    t.results.submit.push({ next: 'running', payload });
    expect(await t.engine.step(job.id)).toBe('advanced');
    expect(t.handler.submit).toHaveBeenCalledTimes(2);
    expect(t.repository.jobs.get(job.id)!.state).toBe('running');
  });

  it('fails with provider_error after MAX_STEP_ATTEMPTS transient retries', async () => {
    const t = setup();
    const job = await t.create({ state: 'running', attempts: 4 });
    t.results.poll.push({ next: 'retry', reason: 'HTTP 503' });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('provider_error');
  });

  it('caps consecutive failures only: transient poll failures between healthy polls never fail the job', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
      t.results.poll.push({ next: 'retry', reason: 'HTTP 503' }, { next: 'poll_again' });
    }
    for (let i = 0; i < MAX_STEP_ATTEMPTS * 2; i++) {
      t.advance(60_000);
      expect(await t.engine.step(job.id)).toBe('advanced');
    }
    expect(t.repository.jobs.get(job.id)).toMatchObject({ state: 'running', attempts: 0 });
    expect(t.handler.poll).toHaveBeenCalledTimes(MAX_STEP_ATTEMPTS * 2);
  });

  it('an unexpected throw in poll is treated as a transient retry', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.results.poll.push(new Error('ECONNRESET'));
    expect(await t.engine.step(job.id)).toBe('advanced');
    expect(t.repository.jobs.get(job.id)!.attempts).toBe(1);
  });

  it('fails with provider_timeout past the deadline and cancels at the provider', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.advance(21 * 60_000);
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.error?.code).toBe('provider_timeout');
    expect(t.handler.cancelAtProvider).toHaveBeenCalled();
  });

  it('a storing job past its deadline still stores and succeeds: the output is already paid for', async () => {
    const t = setup();
    const job = await t.create({ state: 'storing' });
    t.advance(21 * 60_000);
    t.results.store.push({ next: 'succeeded', payload });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.state).toBe('succeeded');
    expect(t.repository.jobs.get(job.id)!.error).toBeUndefined();
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(t.handler.onTerminal).mock.calls[0][0].state).toBe('succeeded');
  });

  it('releases the lease before throwing for a kind with no handler', async () => {
    const t = setup();
    const job = await t.create();
    t.repository.jobs.get(job.id)!.kind = 'unknown' as IGenerationJob['kind'];
    await expect(t.engine.step(job.id)).rejects.toThrow("no generation job handler registered for kind 'unknown'");
    expect(t.repository.jobs.get(job.id)!.leaseUntil).toBeNull();
  });

  it('blocked is terminal with content_blocked and still runs onTerminal', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.results.poll.push({
      next: 'blocked',
      error: { code: 'content_blocked', message: 'policy' },
      rawProviderError: { x: 1 },
    });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.state).toBe('blocked');
    expect(t.repository.jobs.get(job.id)!.rawProviderError).toEqual({ x: 1 });
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
  });

  it.each(['pending', 'running'] as const)('cancel requested while %s cancels', async state => {
    const t = setup();
    const job = await t.create({ state });
    await t.engine.requestCancel(job.id);
    expect(t.enqueue).toHaveBeenLastCalledWith(job.id, 0);
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.repository.jobs.get(job.id)!.state).toBe('cancelled');
    expect(t.handler.cancelAtProvider).toHaveBeenCalledTimes(state === 'running' ? 1 : 0);
  });

  it.each(['storing', 'succeeded'] as const)(
    'requestCancel on a %s job returns null and enqueues nothing',
    async state => {
      const t = setup();
      const job = await t.create({ state });
      expect(await t.engine.requestCancel(job.id)).toBeNull();
      expect(t.repository.jobs.get(job.id)!.cancelRequested).toBe(false);
      expect(t.enqueue).not.toHaveBeenCalled();
    }
  );

  it('cancel requested while storing is ignored: the result is already paid for', async () => {
    const t = setup();
    const job = await t.create({ state: 'storing', cancelRequested: true });
    t.results.store.push({ next: 'succeeded', payload });
    await t.engine.step(job.id);
    expect(t.repository.jobs.get(job.id)!.state).toBe('succeeded');
  });

  it('re-runs onTerminal for a terminal job left unhandled', async () => {
    const t = setup();
    const job = await t.create({ state: 'failed', error: { code: 'provider_error', message: 'x' } });
    expect(await t.engine.step(job.id)).toBe('terminal');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(t.repository.jobs.get(job.id)!.terminalHandledAt).toBeTruthy();
  });

  it('onTerminal is never run twice, even if the first run crashed after claiming', async () => {
    const t = setup();
    const errorSpy = vi.spyOn(t.logger, 'error');
    const job = await t.create({ state: 'failed', error: { code: 'provider_error', message: 'x' } });
    vi.mocked(t.handler.onTerminal).mockRejectedValueOnce(new Error('db down'));
    await expect(t.engine.step(job.id)).rejects.toThrow('db down');
    t.advance(400_000);
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    expect(errorLogsNamed(errorSpy, 'generation_job_terminal_handling_stuck')).toHaveLength(1);
    expect(t.repository.jobs.get(job.id)!.leaseUntil).toBeNull();
  });

  it('a fresh terminal-handling claim held by another run is skipped silently', async () => {
    const t = setup();
    const errorSpy = vi.spyOn(t.logger, 'error');
    const job = await t.create({
      state: 'failed',
      error: { code: 'provider_error', message: 'x' },
      terminalHandlingClaimedAt: t.now(),
    });
    t.advance(1_000);
    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(t.handler.onTerminal).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(t.repository.jobs.get(job.id)!.leaseUntil).toBeNull();
  });

  it('passes every step a live abort signal', async () => {
    const t = setup();
    const job = await t.create({ state: 'running' });
    t.results.poll.push({ next: 'poll_again' });
    await t.engine.step(job.id);
    const [, context] = vi.mocked(t.handler.poll).mock.calls[0];
    expect(context.signal).toBeInstanceOf(AbortSignal);
    expect(context.signal.aborted).toBe(false);
  });

  it('refuses a lease too short to leave the step time to commit after its abort', () => {
    const repository = createInMemoryGenerationJobRepository();
    const logger = new Logger({ metadata: { test: 'engine' } });
    const deps = { repository, handlers: [], enqueue: vi.fn(), notify: vi.fn(), now: () => new Date(), logger };
    expect(() => new GenerationJobEngine({ ...deps, leaseMs: 30_000 })).toThrow(/leaseMs must exceed/);
  });

  it('drops the result of a worker whose lease expired and was taken over mid-step', async () => {
    const t = setup();
    const warnSpy = vi.spyOn(t.logger, 'warn');
    const job = await t.create({ state: 'running' });
    let takeover: Awaited<ReturnType<typeof t.engine.step>> | undefined;
    vi.mocked(t.handler.poll)
      .mockImplementationOnce(async () => {
        // The first worker stalls past its lease; a second worker leases the job and advances it.
        t.advance(LEASE_MS + 1_000);
        takeover = await t.engine.step(job.id);
        return { next: 'failed', error: { code: 'provider_error', message: 'stale result' } } satisfies StepResult;
      })
      .mockImplementationOnce(async () => ({ next: 'poll_again' }) satisfies StepResult);

    expect(await t.engine.step(job.id)).toBe('skipped');
    expect(takeover).toBe('advanced');
    const after = t.repository.jobs.get(job.id)!;
    expect(after).toMatchObject({ state: 'running', pollCount: 1, leaseUntil: null });
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(t.handler.onTerminal).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      'generation job step result dropped: the lease was lost before its commit',
      expect.objectContaining({ jobId: job.id })
    );
  });

  describe('failBeforeStart', () => {
    const enqueueFailed = { code: 'enqueue_failed' as const, message: 'The job could not be queued' };

    it('fails a job no worker has started and runs its terminal handling', async () => {
      const t = setup();
      const job = await t.create();
      expect(await t.engine.failBeforeStart(job.id, enqueueFailed)).toBe('failed');
      expect(t.repository.jobs.get(job.id)).toMatchObject({
        state: 'failed',
        error: enqueueFailed,
        nextPollAt: null,
        terminalHandledAt: expect.any(Date),
      });
      expect(t.handler.onTerminal).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['holds the lease', { leaseUntil: new Date('2026-10-06T00:05:30Z') }],
      ['already submitted', { submitAttemptedAt: new Date('2026-10-06T00:00:00Z') }],
      ['already advanced it', { state: 'running' as const }],
    ])('leaves the job to a worker that %s', async (_name, overrides) => {
      const t = setup();
      const job = await t.create(overrides);
      expect(await t.engine.failBeforeStart(job.id, enqueueFailed)).toBe('skipped');
      expect(t.repository.jobs.get(job.id)!.error).toBeUndefined();
      expect(t.handler.onTerminal).not.toHaveBeenCalled();
    });
  });

  it('a notify failure never fails the step', async () => {
    const t = setup();
    const job = await t.create();
    t.notify.mockRejectedValue(new Error('ws down'));
    t.results.submit.push({ next: 'running', payload });
    await expect(t.engine.step(job.id)).resolves.toBe('advanced');
  });
});
