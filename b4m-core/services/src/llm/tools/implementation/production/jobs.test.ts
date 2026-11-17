import { describe, expect, it, vi } from 'vitest';
import { MUSIC_MODEL_CATALOG, VIDEO_MODEL_CATALOG, type GenerationJobState } from '@bike4mind/common';
import type { ProductionJobView } from './config';
import type { ProductionToolConfig } from './config';
import {
  isTerminal,
  jobOutcome,
  pickMusicModel,
  pickVideoModel,
  submitMusic,
  videoDurationFor,
  waitForJobs,
} from './jobs';

const job = (id: string, state: GenerationJobState, extra: Partial<ProductionJobView> = {}): ProductionJobView => ({
  id,
  state,
  ...extra,
});

describe('pickMusicModel', () => {
  it('prefers an exact-length model that fits over an earlier approximate one', () => {
    expect(MUSIC_MODEL_CATALOG['lyria-3.5'].duration.control).toBe('approximate');
    expect(MUSIC_MODEL_CATALOG['test-music'].duration.control).toBe('exact');
    expect(pickMusicModel(['lyria-3.5', 'test-music'], 15)).toBe('test-music');
  });

  it('takes the first model that fits when none is exact', () => {
    expect(pickMusicModel(['lyria-3-clip-preview', 'lyria-3.5'], 20)).toBe('lyria-3-clip-preview');
    expect(pickMusicModel(['lyria-3.5', 'lyria-3-clip-preview'], 20)).toBe('lyria-3.5');
  });

  it('skips a model whose longest track is shorter than the cut', () => {
    // test-music tops out at 30 s; music_v2 is exact up to 300 s.
    expect(pickMusicModel(['test-music', 'music_v2'], 100)).toBe('music_v2');
  });

  it('falls back to the first usable model when none is long enough, and to undefined when none is usable', () => {
    expect(pickMusicModel(['lyria-3-clip-preview', 'test-music'], 100)).toBe('lyria-3-clip-preview');
    expect(pickMusicModel([], 10)).toBeUndefined();
  });
});

describe('videoDurationFor', () => {
  it('rounds up to a discrete length, capping at the longest', () => {
    const caps = VIDEO_MODEL_CATALOG['veo-3.1-fast-generate-preview'];
    expect(caps.duration).toEqual({ kind: 'discrete', values: [4, 6, 8] });
    expect(videoDurationFor(caps, 3000)).toBe(4);
    expect(videoDurationFor(caps, 5000)).toBe(6);
    expect(videoDurationFor(caps, 8000)).toBe(8);
    expect(videoDurationFor(caps, 20_000)).toBe(8);
  });

  it('rounds a range up to a whole second within min and max', () => {
    const caps = VIDEO_MODEL_CATALOG['gemini-omni-1.1-flash'];
    expect(caps.duration).toEqual({ kind: 'range', min: 3, max: 10, step: 1 });
    expect(videoDurationFor(caps, 1000)).toBe(3);
    expect(videoDurationFor(caps, 4200)).toBe(5);
    expect(videoDurationFor(caps, 60_000)).toBe(10);
  });
});

describe('pickVideoModel', () => {
  it('takes the first model that animates a still from a first frame', () => {
    expect(pickVideoModel(['flux-3-video', 'veo-3.1-fast-generate-preview', 'test-video'])).toBe(
      'veo-3.1-fast-generate-preview'
    );
  });

  it('skips text-to-video-only models, and is undefined when nothing animates a still', () => {
    expect(VIDEO_MODEL_CATALOG['flux-3-video'].modes).not.toContain('image_to_video');
    expect(pickVideoModel(['flux-3-video'])).toBeUndefined();
    expect(pickVideoModel([])).toBeUndefined();
  });
});

describe('isTerminal', () => {
  it('is true for finished states and false for in-flight ones', () => {
    expect(
      ['succeeded', 'failed', 'blocked', 'cancelled'].map(state => isTerminal(job('j', state as GenerationJobState)))
    ).toEqual([true, true, true, true]);
    expect(['pending', 'running', 'storing'].map(state => isTerminal(job('j', state as GenerationJobState)))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

describe('waitForJobs', () => {
  const timing = { waitTimeoutMs: 2000, pollIntervalMs: 1 };

  it('returns at once without polling when there are no ids', async () => {
    const findJobs = vi.fn();
    const result = await waitForJobs({ findJobs, ...timing }, []);
    expect(result.size).toBe(0);
    expect(findJobs).not.toHaveBeenCalled();
  });

  it('polls until every job is terminal', async () => {
    let polls = 0;
    const findJobs = vi.fn(async (ids: readonly string[]) => {
      polls += 1;
      const state: GenerationJobState = polls >= 3 ? 'succeeded' : 'running';
      return ids.map(id => job(id, state, { fileId: 'f'.repeat(24) }));
    });

    const result = await waitForJobs({ findJobs, ...timing }, ['a', 'b']);

    expect(findJobs).toHaveBeenCalledTimes(3);
    expect(findJobs).toHaveBeenCalledWith(['a', 'b']);
    expect([...result.values()].map(item => item.state)).toEqual(['succeeded', 'succeeded']);
  });

  it('does not treat a job the lookup did not return as done', async () => {
    let polls = 0;
    const findJobs = vi.fn(async () => (++polls < 2 ? [] : [job('a', 'failed')]));
    const result = await waitForJobs({ findJobs, ...timing }, ['a']);
    expect(findJobs).toHaveBeenCalledTimes(2);
    expect(result.get('a')?.state).toBe('failed');
  });

  it('hands back what is still running once the deadline passes', async () => {
    const findJobs = vi.fn(async (ids: readonly string[]) => ids.map(id => job(id, 'running')));
    const result = await waitForJobs({ findJobs, waitTimeoutMs: 30, pollIntervalMs: 5 }, ['a']);
    expect(result.get('a')?.state).toBe('running');
    expect(findJobs.mock.calls.length).toBeGreaterThan(1);
    expect(findJobs.mock.calls.length).toBeLessThan(10);
  });

  it('stops after one read when the signal is already aborted', async () => {
    const findJobs = vi.fn(async (ids: readonly string[]) => ids.map(id => job(id, 'running')));
    const controller = new AbortController();
    controller.abort();
    const result = await waitForJobs({ findJobs, ...timing }, ['a'], controller.signal);
    expect(findJobs).toHaveBeenCalledTimes(1);
    expect(result.get('a')?.state).toBe('running');
  });
});

describe('jobOutcome', () => {
  it('says a missing job was not found', () => {
    expect(jobOutcome(undefined)).toBe('not found');
  });

  it('says an in-flight job is still going, with its state', () => {
    expect(jobOutcome(job('a', 'running'))).toBe('still running');
    expect(jobOutcome(job('a', 'pending'))).toBe('still pending');
  });

  it('returns the bare state for a clean finish', () => {
    expect(jobOutcome(job('a', 'succeeded'))).toBe('succeeded');
  });

  it('carries the error code and message of a failed job', () => {
    expect(jobOutcome(job('a', 'failed', { error: { code: 'content_blocked', message: 'Nope' } }))).toBe(
      'failed (content_blocked): Nope'
    );
  });
});

describe('submitMusic retries', () => {
  const context = {
    userId: 'user1',
    questId: 'quest1',
    user: { isAdmin: false },
    statusUpdate: vi.fn(async () => undefined),
  } as never;
  const replay = (id: string, state: GenerationJobState, created = false) => ({
    ok: true as const,
    created,
    job: { id, state },
  });
  const configWith = (createJob: ReturnType<typeof vi.fn>) =>
    ({ music: { usableModels: ['test-music'], createJob } }) as unknown as ProductionToolConfig;

  it('moves past a replay of a failed job under a new key, and keeps attaching to a running one', async () => {
    const createJob = vi
      .fn()
      .mockResolvedValueOnce(replay('dead', 'failed'))
      .mockResolvedValueOnce(replay('fresh', 'queued', true));
    expect(await submitMusic(context, configWith(createJob), { prompt: 'calm', seconds: 10 })).toEqual({
      ok: true,
      jobIds: ['fresh'],
    });
    const keys = createJob.mock.calls.map(([input]) => (input as { idempotencyKey: string }).idempotencyKey);
    expect(new Set(keys).size).toBe(2);

    const running = vi.fn().mockResolvedValue(replay('live', 'running'));
    expect(await submitMusic(context, configWith(running), { prompt: 'calm', seconds: 10 })).toEqual({
      ok: true,
      jobIds: ['live'],
    });
    expect(running).toHaveBeenCalledTimes(1);
    expect((running.mock.calls[0]![0] as { idempotencyKey: string }).idempotencyKey).toBe(keys[0]);
  });

  it('gives up once every attempt has failed', async () => {
    const createJob = vi.fn().mockResolvedValue(replay('dead', 'failed'));
    const result = await submitMusic(context, configWith(createJob), { prompt: 'calm', seconds: 10 });
    expect(result.ok).toBe(false);
    expect(createJob).toHaveBeenCalledTimes(3);
  });
});
