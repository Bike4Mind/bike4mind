import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PublicImageJob } from '@bike4mind/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunBudgetExhaustedError } from '../completions';
import { generateImage } from './imageGeneration';
import { MediaToolError, type MediaApiClient } from './MediaApiClient';
import { MediaStore } from './MediaStore';

const SESSION = 'f1a2b3c4-0000-4000-8000-000000000001';

const REQUEST = { prompt: 'a bicycle', model: 'gpt-image-1-mini' };

const JOB: PublicImageJob = {
  id: 'job1',
  object: 'image_generation',
  state: 'pending',
  model: 'gpt-image-1-mini',
  mode: 'generate',
  prompt: 'a bicycle',
  group_id: 'grp1',
  source: 'agent',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: 'x',
  updated_at: 'x',
};

const RUNNING: PublicImageJob = { ...JOB, state: 'running' };
const DONE: PublicImageJob = {
  ...JOB,
  state: 'succeeded',
  output: {
    availability: 'ready',
    url: 'https://cdn.example/generated/a.png',
    expires_at: null,
    content_type: 'image/png',
    file_id: null,
  },
};

interface Harness {
  getImageJob: ReturnType<typeof vi.fn>;
  createImageJob: ReturnType<typeof vi.fn>;
  cancelImageJob: ReturnType<typeof vi.fn>;
  fetchGenerated: ReturnType<typeof vi.fn>;
  progress: string[];
  deps: Parameters<typeof generateImage>[1];
}

async function harness(polls: PublicImageJob[]): Promise<Harness> {
  const getImageJob = vi.fn();
  for (const poll of polls) getImageJob.mockResolvedValueOnce(poll);
  getImageJob.mockResolvedValue(polls[polls.length - 1]);

  const createImageJob = vi.fn().mockResolvedValue([JOB]);
  const cancelImageJob = vi.fn().mockResolvedValue({ ...JOB, state: 'cancelled' });
  const fetchGenerated = vi.fn().mockResolvedValue({ bytes: Buffer.from('png'), contentType: 'image/png' });
  const client = { createImageJob, getImageJob, cancelImageJob, fetchGenerated } as unknown as MediaApiClient;

  const progress: string[] = [];
  return {
    getImageJob,
    createImageJob,
    cancelImageJob,
    fetchGenerated,
    progress,
    deps: {
      client,
      store: new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-imagegen-'))),
      sessionId: SESSION,
      signal: new AbortController().signal,
      progress: text => progress.push(text),
    },
  };
}

/**
 * Settle the generation and hand back whatever it produced, error included.
 *
 * The catch is attached before the timers run on purpose: a rejection that is only awaited
 * afterwards is briefly unhandled while the fake clock advances, which vitest reports as an
 * unhandled rejection and fails the run.
 */
async function settle(promise: Promise<unknown>, advanceMs: number): Promise<unknown> {
  const outcome = promise.then(
    value => value,
    error => error as unknown
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

describe('generateImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates one generate job with an idempotency key, then polls until it succeeds', async () => {
    const h = await harness([RUNNING, RUNNING, DONE]);
    const promise = generateImage({ ...REQUEST, size: '1024x1024' }, h.deps);
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await promise;

    expect(h.createImageJob).toHaveBeenCalledWith(
      { model: 'gpt-image-1-mini', mode: 'generate', prompt: 'a bicycle', count: 1, size: '1024x1024' },
      expect.stringMatching(/^[0-9a-f-]{36}$/)
    );
    expect(h.getImageJob).toHaveBeenCalledTimes(3);
    expect(h.getImageJob).toHaveBeenCalledWith('job1', expect.any(AbortSignal));
    expect(h.fetchGenerated).toHaveBeenCalledWith('https://cdn.example/generated/a.png');
    expect(outcome.media).toHaveLength(1);
    expect(outcome.media[0]).toMatchObject({ kind: 'image', mimeType: 'image/png', caption: 'a bicycle' });
    expect(outcome.media[0].url).toMatch(/^b4m-media:\/\//);
    expect(h.progress[0]).toMatch(/Queuing/);
    expect(h.progress.filter(line => /^Generating\.\.\. \d+s$/.test(line))).toHaveLength(2);
    expect(h.progress[h.progress.length - 1]).toMatch(/Downloading/);
  });

  it('keeps polling a succeeded job whose file is still being scanned', async () => {
    const scanning: PublicImageJob = {
      ...DONE,
      output: { ...DONE.output!, availability: 'pending_scan', url: null },
    };
    const h = await harness([scanning, DONE]);
    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(h.getImageJob).toHaveBeenCalledTimes(2);
  });

  it('stops on an output that will never be downloadable', async () => {
    const blocked: PublicImageJob = {
      ...DONE,
      output: { ...DONE.output!, availability: 'unavailable', url: null },
    };
    const h = await harness([blocked]);

    expect(await settle(generateImage(REQUEST, h.deps), 5_000)).toMatchObject({
      message: expect.stringMatching(/not available to download/),
    });
    expect(h.fetchGenerated).not.toHaveBeenCalled();
  });

  it.each(['failed', 'blocked', 'cancelled'] as const)(
    'surfaces the server message when the job is %s',
    async state => {
      const h = await harness([
        { ...JOB, state, error: { code: 'content_blocked', message: 'The prompt was refused.' } },
      ]);

      expect(await settle(generateImage(REQUEST, h.deps), 5_000)).toMatchObject({
        message: 'The prompt was refused.',
      });
      expect(h.fetchGenerated).not.toHaveBeenCalled();
    }
  );

  it('lets a credit refusal on create through with its notice', async () => {
    const h = await harness([DONE]);
    h.createImageJob.mockRejectedValue(
      new MediaToolError('Out of credits.', { kind: 'insufficient-credits', text: 'Out of credits.' })
    );

    await expect(generateImage(REQUEST, h.deps)).rejects.toMatchObject({
      notice: { kind: 'insufficient-credits' },
    });
    expect(h.getImageJob).not.toHaveBeenCalled();
  });

  // The run's claim is taken with the job's hold, so a refusal arrives on create, never on a poll.
  it('lets a run budget refusal on create through, so the run pauses', async () => {
    const h = await harness([DONE]);
    h.createImageJob.mockRejectedValue(new RunBudgetExhaustedError('Run budget used up.'));

    await expect(generateImage(REQUEST, h.deps)).rejects.toBeInstanceOf(RunBudgetExhaustedError);
    expect(h.getImageJob).not.toHaveBeenCalled();
  });

  it('rides out a single failed poll but gives up on two in a row', async () => {
    const h = await harness([DONE]);
    h.getImageJob.mockReset();
    h.getImageJob.mockRejectedValueOnce(new Error('network blip')).mockResolvedValueOnce(DONE);

    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toMatchObject({ media: [{ kind: 'image' }] });

    const failing = await harness([DONE]);
    failing.getImageJob.mockReset();
    failing.getImageJob.mockRejectedValue(new Error('gone'));
    expect(await settle(generateImage(REQUEST, failing.deps), 10_000)).toMatchObject({
      message: expect.stringMatching(/Lost contact[\s\S]*gone[\s\S]*\(job1\)/),
    });
  });

  it('waits out a 429 without counting it as a failed read', async () => {
    const h = await harness([DONE]);
    h.getImageJob.mockReset();
    const limited = Object.assign(new MediaToolError('slow down'), { status: 429, retryAfterMs: 20_000 });
    h.getImageJob
      .mockRejectedValueOnce(limited)
      .mockRejectedValueOnce(limited)
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce(DONE);

    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.getImageJob).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100_000);

    await expect(promise).resolves.toMatchObject({ media: [{ kind: 'image' }] });
    expect(h.getImageJob).toHaveBeenCalledTimes(4);
  });

  it('keeps a 429 bounded by the deadline', async () => {
    const h = await harness([DONE]);
    h.getImageJob.mockReset();
    h.getImageJob.mockRejectedValue(Object.assign(new MediaToolError('slow down'), { status: 429 }));

    expect(await settle(generateImage(REQUEST, h.deps), 400_000)).toMatchObject({
      message: expect.stringMatching(/still generating after 180s/),
    });
  });

  it('fails fast on a succeeded job that has no output', async () => {
    const h = await harness([{ ...DONE, output: null }]);

    expect(await settle(generateImage(REQUEST, h.deps), 5_000)).toMatchObject({
      message: expect.stringMatching(/not stored/),
    });
    expect(h.getImageJob).toHaveBeenCalledTimes(1);
  });

  it('says the file is being scanned when the deadline lands during a scan', async () => {
    const scanning: PublicImageJob = {
      ...DONE,
      output: { ...DONE.output!, availability: 'pending_scan', url: null },
    };
    const h = await harness([scanning]);

    expect(await settle(generateImage(REQUEST, h.deps), 200_000)).toMatchObject({
      message: expect.stringMatching(/being scanned[\s\S]*job job1/),
    });
  });

  it('carries the stored file id onto the media', async () => {
    const h = await harness([{ ...DONE, output: { ...DONE.output!, file_id: 'file9' } }]);
    const promise = generateImage(REQUEST, h.deps);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toMatchObject({ media: [{ kind: 'image', fabFileId: 'file9' }] });
  });

  it('gives up on a job that never settles, naming it so it can be found later', async () => {
    const h = await harness([RUNNING]);
    expect(await settle(generateImage(REQUEST, h.deps), 200_000)).toMatchObject({
      message: expect.stringMatching(/still generating after 180s[\s\S]*job job1/),
    });
    expect(h.cancelImageJob).not.toHaveBeenCalled();
  });

  it('cancels the created job when the turn is aborted while the create is in flight', async () => {
    const controller = new AbortController();
    const h = await harness([RUNNING]);
    h.createImageJob.mockImplementation(async () => {
      controller.abort();
      return [JOB];
    });

    const outcome = await generateImage(REQUEST, { ...h.deps, signal: controller.signal }).then(
      value => value,
      error => error as Error
    );

    expect(outcome).toMatchObject({ message: expect.stringMatching(/stopped/) });
    expect(h.cancelImageJob).toHaveBeenCalledWith('job1');
    expect(h.getImageJob).not.toHaveBeenCalled();
  });

  it('stops and cancels the job when the turn is aborted mid-poll', async () => {
    const controller = new AbortController();
    const h = await harness([RUNNING]);
    const promise = generateImage(REQUEST, { ...h.deps, signal: controller.signal }).then(
      value => value,
      error => error as Error
    );

    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await promise).toMatchObject({ message: expect.stringMatching(/stopped/) });
    expect(h.cancelImageJob).toHaveBeenCalledWith('job1');
  });

  it.each([
    ['quietly accepts a refused cancel (409)', 409, false],
    ['logs any other cancel failure, since the stopped job keeps running', 500, true],
  ])('%s', async (_name, status, logged) => {
    const controller = new AbortController();
    const h = await harness([RUNNING]);
    const refusal = new MediaToolError('Cancelling the image failed');
    refusal.status = status;
    h.cancelImageJob.mockRejectedValue(refusal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const promise = generateImage(REQUEST, { ...h.deps, signal: controller.signal }).then(
      value => value,
      error => error as Error
    );

    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await promise).toMatchObject({ message: expect.stringMatching(/stopped/) });
    expect(warn).toHaveBeenCalledTimes(logged ? 1 : 0);
    warn.mockRestore();
  });
});
