import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IGenerationJobDocument } from '@bike4mind/common';
import { runJobInline, type RunJobInlineDeps } from './runInline';

const jobInState = (state: IGenerationJobDocument['state']): IGenerationJobDocument => ({
  id: 'job1',
  kind: 'speech',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'api',
  state,
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-10-13T00:05:00Z'),
  creditHold: null,
  payload: { request: { text: 'hi', provider: 'openai' }, candidates: ['openai'], saveToFiles: true },
});

// A fake clock the injected sleep advances, so a timeout needs no real waiting.
const setup = (states: Array<IGenerationJobDocument['state'] | null>) => {
  let clock = 0;
  const queue = [...states];
  const step = vi.fn<RunJobInlineDeps['engine']['step']>(async () => 'ran' as never);
  const findById = vi.fn(async () => {
    const state = queue.length > 1 ? queue.shift() : queue[0];
    return state ? jobInState(state) : null;
  });
  const sleep = vi.fn(async (ms: number) => {
    clock += ms;
  });
  const deps: RunJobInlineDeps = {
    engine: { step },
    repository: { findById },
    now: () => new Date(clock),
    sleep,
  };
  return { deps, step, findById, sleep };
};

describe('runJobInline', () => {
  it('returns the terminal job after the first step without sleeping', async () => {
    const { deps, step, sleep } = setup(['succeeded']);
    const job = await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps);
    expect(job).toMatchObject({ id: 'job1', state: 'succeeded' });
    expect(step).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'failed', 'blocked', 'cancelled'] as const)('returns a %s job', async state => {
    const { deps } = setup([state]);
    expect(await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps)).toMatchObject({ state });
  });

  it('keeps stepping a job that waits on a retry until it ends', async () => {
    const { deps, step, sleep } = setup(['pending', 'running', 'succeeded']);
    const job = await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0, pollIntervalMs: 100 }, deps);
    expect(job).toMatchObject({ state: 'succeeded' });
    expect(step).toHaveBeenCalledTimes(3);
    expect(step).toHaveBeenCalledWith('job1', expect.any(Object));
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
  });

  it('sleeps the default interval between steps', async () => {
    const { deps, sleep } = setup(['pending', 'succeeded']);
    await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('never sleeps past the deadline', async () => {
    const { deps, sleep } = setup(['pending', 'pending']);
    await runJobInline('job1', { timeoutMs: 300, minStepMs: 0, pollIntervalMs: 500 }, deps);
    expect(sleep).toHaveBeenCalledWith(300);
  });

  it('returns null when the job does not end within the timeout', async () => {
    const { deps, step } = setup(['pending']);
    expect(await runJobInline('job1', { timeoutMs: 1_000, minStepMs: 0, pollIntervalMs: 400 }, deps)).toBeNull();
    // Steps at t=0, 400 and 800; at 1200 the deadline has passed.
    expect(step).toHaveBeenCalledTimes(3);
  });

  it('returns null without stepping when the timeout is already spent', async () => {
    const { deps, step } = setup(['succeeded']);
    expect(await runJobInline('job1', { timeoutMs: 0, minStepMs: 0 }, deps)).toBeNull();
    expect(step).not.toHaveBeenCalled();
  });

  it('returns null when the job disappears', async () => {
    const { deps, step, sleep } = setup([null]);
    expect(await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps)).toBeNull();
    expect(step).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('returns null when the job disappears after a step that left it running', async () => {
    const { deps, step } = setup(['pending', null]);
    expect(await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps)).toBeNull();
    expect(step).toHaveBeenCalledTimes(2);
  });

  it('gives each step the time left plus the commit margin', async () => {
    const { deps, step } = setup(['pending', 'pending', 'succeeded']);
    await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0, pollIntervalMs: 1_000 }, deps);
    expect(step).toHaveBeenNthCalledWith(1, 'job1', { remainingMs: 10_000 + 30_000 });
    expect(step).toHaveBeenNthCalledWith(2, 'job1', { remainingMs: 9_000 + 30_000 });
    expect(step).toHaveBeenNthCalledWith(3, 'job1', { remainingMs: 8_000 + 30_000 });
  });

  it('only polls once the time left is under minStepMs, leaving the step to the worker', async () => {
    const { deps, step, findById } = setup(['pending', 'pending', 'succeeded']);
    const job = await runJobInline('job1', { timeoutMs: 10_000, minStepMs: 9_500, pollIntervalMs: 1_000 }, deps);
    expect(job).toMatchObject({ state: 'succeeded' });
    // Only the first pass (10s left) may step; at 9s and 8s left a full provider call no longer fits.
    expect(step).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledTimes(3);
  });

  it('never steps when the whole wait is shorter than minStepMs', async () => {
    const { deps, step } = setup(['pending']);
    expect(await runJobInline('job1', { timeoutMs: 1_000, minStepMs: 5_000, pollIntervalMs: 400 }, deps)).toBeNull();
    expect(step).not.toHaveBeenCalled();
  });

  it('lets an engine failure propagate', async () => {
    const { deps, step } = setup(['pending']);
    step.mockRejectedValueOnce(new Error('engine down'));
    await expect(runJobInline('job1', { timeoutMs: 10_000, minStepMs: 0 }, deps)).rejects.toThrow('engine down');
  });
});
