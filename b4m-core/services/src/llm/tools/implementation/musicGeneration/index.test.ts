import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';
import {
  ARTIST_REFERENCE_REFUSAL,
  PROVIDER_BLOCK_REFUSAL,
  isMusicToolConfig,
  musicGenerationTool,
  namesArtistReference,
  type MusicToolConfig,
} from './index';

const okJob = { ok: true as const, created: true, job: { id: 'job1' } };

type BuildOptions = {
  questId?: string;
  usableModels?: MusicToolConfig['usableModels'];
  findJob?: MusicToolConfig['findJob'];
  releaseDiscardedJob?: MusicToolConfig['releaseDiscardedJob'];
  signal?: AbortSignal;
};

const build = (createJob: MusicToolConfig['createJob'], options: BuildOptions = {}) => {
  const { usableModels = ['test-music'], findJob, releaseDiscardedJob, signal } = options;
  const questId = 'questId' in options ? options.questId : 'q1';
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn();
  const onFinish = vi.fn();
  const config: MusicToolConfig = {
    usableModels,
    createJob,
    ...(findJob && { findJob }),
    ...(releaseDiscardedJob && { releaseDiscardedJob }),
  };
  const logger = { warn: vi.fn() };
  const context = {
    logger,
    getAbortSignal: () => signal,
    userId: 'u1',
    user: { id: 'u1', isAdmin: false },
    organizationId: 'org1',
    sessionId: 's1',
    questId,
    statusUpdate,
    onStart,
    onFinish,
  } as never;
  return { tool: musicGenerationTool.implementation(context, config), statusUpdate, onStart, onFinish, logger };
};

describe('music_generation tool', () => {
  it('starts an agent-sourced job for the notebook and message, and returns the job id with an estimate', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'a sea shanty' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(createJob.mock.calls[0][0]).toMatchObject({
      source: 'agent',
      sessionId: 's1',
      questId: 'q1',
      user: { id: 'u1', organizationId: 'org1', adminRoleWithheld: true },
      request: { model: 'test-music', prompt: 'a sea shanty' },
    });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  it('song prompts written from chat describe style without naming artists', async () => {
    const named = [
      'upbeat pop in the style of Some Singer',
      'sounds like The Example Group',
      'inspired by Name Surname, slow tempo',
      'a slow ballad inspired by the Example Group',
      'In the style of Some Singer, a slow ballad',
      'A ballad. Sounds like \u00c9mile Example',
      'A ROCK SONG IN THE STYLE OF SOME SINGER',
      'in the vein of Some Singer',
      'in the style of Motown, inspired by Some Singer',
      'in the style of Detroit Example Singer',
      'in the style of J. Example Singer',
    ];
    for (const prompt of named) {
      const createJob = vi.fn().mockResolvedValue(okJob);
      const { tool, statusUpdate } = build(createJob);
      const result = await tool.toolFn({ model: 'test-music', prompt });
      expect(result).toMatch(/^Music generation failed \(artist_reference\).*rewrite/i);
      expect(createJob).not.toHaveBeenCalled();
      expect(statusUpdate).not.toHaveBeenCalled();
    }

    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    const described = 'upbeat indie pop, jangly guitars, handclaps, 120 bpm, in the style of 2010s radio hits';
    expect(JSON.parse(await tool.toolFn({ model: 'test-music', prompt: described })).jobId).toBe('job1');
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('refuses an artist-shaped prompt at most once per turn, so a false positive cannot block the song', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    const prompt = 'a sonnet set to lute music, inspired by Example Soloist';
    expect(await tool.toolFn({ model: 'test-music', prompt })).toBe(ARTIST_REFERENCE_REFUSAL);
    expect(JSON.parse(await tool.toolFn({ model: 'test-music', prompt })).jobId).toBe('job1');
    expect(createJob).toHaveBeenCalledTimes(1);

    // The refusal belongs to the built tool, so the next turn gets its own.
    const fresh = build(createJob);
    expect(await fresh.tool.toolFn({ model: 'test-music', prompt })).toBe(ARTIST_REFERENCE_REFUSAL);
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('only inspects the capitalized run on the same line as the style phrase', () => {
    expect(namesArtistReference('warm and slow, inspired by\nSome Singer')).toBe(true);
    expect(namesArtistReference('in the style of jazz\nVerse 1 starts quiet')).toBe(false);
    expect(namesArtistReference('in the style of Latin\nVerse one')).toBe(false);
  });

  it('allows genre and regional style words after style phrases', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    const prompts = [
      'a track in the style of Motown',
      'sounds like Latin jazz with congas',
      'sounds like Spanish guitar',
      'in the vein of Celtic folk, fiddle and whistle',
      'Like a lullaby, inspired by Delta blues',
      'a track in the style of Motown.',
      'in the style of Motown. Female vocals, warm',
      'sounds like Celtic-Irish fusion',
      'in the style of A minor ballad, piano only',
      "warm strings, inspired by Nashville's session players",
    ];
    for (const prompt of prompts) {
      expect(JSON.parse(await tool.toolFn({ model: 'test-music', prompt })).jobId).toBe('job1');
    }
    expect(createJob).toHaveBeenCalledTimes(prompts.length);
  });

  it('passes lyrics, instrumental and length through and leaves omitted fields to the job', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-music', prompt: 'p', lyrics: '[Verse]\nla la', durationSeconds: 10 });
    await tool.toolFn({ model: 'test-music', prompt: 'p', instrumental: true });
    expect(createJob.mock.calls[0][0].request).toEqual({
      model: 'test-music',
      prompt: 'p',
      lyrics: '[Verse]\nla la',
      durationSeconds: 10,
    });
    expect(createJob.mock.calls[1][0].request).toEqual({ model: 'test-music', prompt: 'p', instrumental: true });
  });

  it('returns a readable refusal without a card when the job is refused', async () => {
    const createJob = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      code: 'unsupported_duration',
      message: 'duration 20s is not supported',
    });
    const { tool, statusUpdate } = build(createJob);
    const result = await tool.toolFn({ model: 'test-music', prompt: 'p', durationSeconds: 20 });
    expect(result).toBe('Music generation failed (unsupported_duration): duration 20s is not supported');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('refuses to report an idempotent replay of a job that already ended without a song', async () => {
    const createJob = vi.fn().mockResolvedValue({
      ok: true,
      created: false,
      job: { id: 'job1', state: 'failed', error: { code: 'provider_error', message: 'boom' } },
    });
    const { tool, statusUpdate } = build(createJob);
    const result = await tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(result).toBe('Music generation failed (provider_error): an identical request already ended without a song.');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('still reports an idempotent replay of a job that already succeeded', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true, created: false, job: { id: 'job1', state: 'succeeded' } });
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'p' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  // The dead-job guard only applies to a replay: a job created now must show its card even if it is already terminal.
  it('still reports a freshly created job that is already terminal', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true, created: true, job: { id: 'job1', state: 'blocked' } });
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'p' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  it('rejects a model the caller cannot use before starting a job', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await expect(tool.toolFn({ model: 'lyria-3.5', prompt: 'p' })).rejects.toThrow();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('uses a stable idempotency key per quest and request, and none without a quest', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    const [first, second] = createJob.mock.calls.map(call => call[0].idempotencyKey);
    expect(first).toMatch(/^agent:u1:q1:[0-9a-f]{32}$/);
    expect(second).toBe(first);

    const noQuest = vi.fn().mockResolvedValue(okJob);
    await build(noQuest, { questId: undefined }).tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(noQuest.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('never bills through onStart/onFinish: the job holds and settles the credits', async () => {
    const { tool, onStart, onFinish } = build(vi.fn().mockResolvedValue(okJob));
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(onStart).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('propagates a createJob failure without emitting a card', async () => {
    const createJob = vi.fn().mockRejectedValue(new Error('db down'));
    const { tool, statusUpdate } = build(createJob);
    await expect(tool.toolFn({ model: 'test-music', prompt: 'p' })).rejects.toThrow('db down');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  // The job is created and billed before the card is announced, so a statusUpdate failure must not be swallowed:
  // the caller sees the error and the running job is left for the websocket/reload to pick up.
  it('propagates a statusUpdate failure after the job was created', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    statusUpdate.mockRejectedValue(new Error('socket closed'));
    await expect(tool.toolFn({ model: 'test-music', prompt: 'p' })).rejects.toThrow('socket closed');
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('offers only the usable models in a plain JSON Schema', () => {
    const { tool } = build(vi.fn(), { usableModels: ['test-music', 'music_v2'] });
    const { parameters } = tool.toolSchema;
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters.properties.model).toMatchObject({ enum: ['test-music', 'music_v2'] });
  });

  it('builds an inert tool when no config is wired', async () => {
    const tool = musicGenerationTool.implementation({ userId: 'u1' } as never, undefined);
    expect(await tool.toolFn({})).toContain('not available');
  });

  it('rejects an empty or malformed config', () => {
    expect(isMusicToolConfig({ usableModels: [], createJob: vi.fn() })).toBe(false);
    expect(isMusicToolConfig({ usableModels: ['test-music'] })).toBe(false);
    expect(isMusicToolConfig(null)).toBe(false);
    expect(isMusicToolConfig({ usableModels: ['test-music'], createJob: vi.fn() })).toBe(true);
  });

  describe('early provider block', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const running = { id: 'job1', kind: 'music', state: 'running', payload: {} };
    const blocked = {
      id: 'job1',
      kind: 'music',
      state: 'blocked',
      error: { code: 'content_blocked', message: 'blocked' },
      payload: {},
    };
    const runningJob = { ok: true as const, created: true, job: running };

    // Advances through the whole wait so a call that polls to the end still resolves.
    const call = async (tool: ReturnType<typeof build>['tool'], prompt = 'a sea shanty') => {
      const pending = tool.toolFn({ model: 'test-music', prompt });
      await vi.advanceTimersByTimeAsync(10_000);
      return pending;
    };

    it('asks for a rephrase without a card when the provider blocks the prompt during the wait', async () => {
      const findJob = vi.fn().mockResolvedValueOnce(running).mockResolvedValue(blocked);
      const releaseDiscardedJob = vi.fn().mockResolvedValue(undefined);
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob, releaseDiscardedJob });
      expect(await call(tool)).toBe(PROVIDER_BLOCK_REFUSAL);
      expect(findJob).toHaveBeenCalledTimes(2);
      expect(findJob).toHaveBeenCalledWith('job1');
      expect(releaseDiscardedJob).toHaveBeenCalledWith('job1');
      expect(statusUpdate).not.toHaveBeenCalled();
    });

    it('asks for a rephrase when the job is already blocked at creation, without polling', async () => {
      const findJob = vi.fn();
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue({ ok: true, created: true, job: blocked }), {
        findJob,
      });
      expect(await call(tool)).toBe(PROVIDER_BLOCK_REFUSAL);
      expect(findJob).not.toHaveBeenCalled();
      expect(statusUpdate).not.toHaveBeenCalled();
    });

    it('asks for a rephrase only once, so a second block shows the card', async () => {
      const createJob = vi
        .fn()
        .mockResolvedValueOnce(runningJob)
        .mockResolvedValueOnce({ ok: true, created: true, job: { ...running, id: 'job2' } });
      const findJob = vi.fn().mockResolvedValue(blocked);
      const { tool, statusUpdate } = build(createJob, { findJob });
      expect(await call(tool)).toBe(PROVIDER_BLOCK_REFUSAL);
      expect(JSON.parse(await call(tool, 'a calmer sea shanty'))).toEqual({ jobId: 'job2', estimatedSeconds: 2 });
      expect(findJob).toHaveBeenCalledTimes(1);
      expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job2', kind: 'music' }] });
    });

    // The discarded job had no card, so the replay guard must show it or the user never sees the block.
    it('shows the card of a discarded job when the model retries the identical prompt', async () => {
      const createJob = vi
        .fn()
        .mockResolvedValueOnce(runningJob)
        .mockResolvedValueOnce({ ok: true, created: false, job: blocked });
      const findJob = vi.fn().mockResolvedValue(blocked);
      const { tool, statusUpdate } = build(createJob, { findJob });
      expect(await call(tool)).toBe(PROVIDER_BLOCK_REFUSAL);
      expect(statusUpdate).not.toHaveBeenCalled();
      expect(await call(tool)).toBe(
        'Music generation failed (content_blocked): an identical request already ended without a song.'
      );
      expect(statusUpdate).toHaveBeenCalledExactlyOnceWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
    });

    it('shows the card of an unbilled block on a dead replay in a freshly built tool instance', async () => {
      const createJob = vi.fn().mockResolvedValue({ ok: true, created: false, job: blocked });
      const findJob = vi.fn();
      const { tool, statusUpdate } = build(createJob, { findJob });
      expect(await call(tool)).toBe(
        'Music generation failed (content_blocked): an identical request already ended without a song.'
      );
      expect(statusUpdate).toHaveBeenCalledExactlyOnceWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
    });

    it('does not wait for an early block on a replay of a job that is still running', async () => {
      const createJob = vi.fn().mockResolvedValue({ ok: true, created: false, job: running });
      const findJob = vi.fn().mockResolvedValue(blocked);
      const { tool, statusUpdate } = build(createJob, { findJob });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(findJob).not.toHaveBeenCalled();
      expect(statusUpdate).toHaveBeenCalledExactlyOnceWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
    });

    it('shares the one rephrase with the artist guard', async () => {
      const findJob = vi.fn().mockResolvedValue(blocked);
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(await call(tool, 'a song in the style of Example Band')).toBe(ARTIST_REFERENCE_REFUSAL);
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(findJob).not.toHaveBeenCalled();
      expect(statusUpdate).toHaveBeenCalledOnce();
    });

    it('keeps the card for a billed block so the charge stays visible, and reports the failure', async () => {
      const findJob = vi.fn().mockResolvedValue({ ...blocked, payload: { billedBlock: true } });
      const releaseDiscardedJob = vi.fn();
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob, releaseDiscardedJob });
      expect(await call(tool)).toBe(
        'Music generation failed (content_blocked): the job ended without a song; its card shows the outcome.'
      );
      expect(statusUpdate).toHaveBeenCalledOnce();
      expect(releaseDiscardedJob).not.toHaveBeenCalled();
    });

    it('reports a block with another code as a failure with its card, not a rephrase', async () => {
      const findJob = vi.fn().mockResolvedValue({ ...blocked, error: { code: 'provider_error', message: 'x' } });
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(await call(tool)).toMatch(/^Music generation failed \(provider_error\)/);
      expect(statusUpdate).toHaveBeenCalledOnce();
    });

    it('reports a song that finished during the wait as started, with its card', async () => {
      const findJob = vi.fn().mockResolvedValue({ ...running, state: 'succeeded' });
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(statusUpdate).toHaveBeenCalledOnce();
    });

    it('offers the rephrase to only one of two parallel calls', async () => {
      const createJob = vi
        .fn()
        .mockResolvedValueOnce(runningJob)
        .mockResolvedValueOnce({ ok: true, created: true, job: { ...running, id: 'job2' } });
      const findJob = vi.fn().mockResolvedValue(blocked);
      const { tool } = build(createJob, { findJob });
      const first = tool.toolFn({ model: 'test-music', prompt: 'one' });
      const second = tool.toolFn({ model: 'test-music', prompt: 'two' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await first).toBe(PROVIDER_BLOCK_REFUSAL);
      expect(JSON.parse(await second)).toEqual({ jobId: 'job2', estimatedSeconds: 2 });
    });

    it('gives the rephrase back when the wait ends without a block', async () => {
      const findJob = vi
        .fn()
        .mockResolvedValueOnce({ ...running, state: 'succeeded' })
        .mockResolvedValue(blocked);
      const { tool } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      JSON.parse(await call(tool));
      expect(await call(tool, 'another')).toBe(PROVIDER_BLOCK_REFUSAL);
    });

    it('stops waiting once the turn is aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const findJob = vi.fn();
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), {
        findJob,
        signal: controller.signal,
      });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(findJob).not.toHaveBeenCalled();
      expect(statusUpdate).toHaveBeenCalledOnce();
    });

    it('stops waiting when the job vanishes', async () => {
      const findJob = vi.fn().mockResolvedValue(null);
      const { tool } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(findJob).toHaveBeenCalledOnce();
    });

    it('stops waiting after six polls and reports the running job', async () => {
      const findJob = vi.fn().mockResolvedValue(running);
      const { tool, statusUpdate } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(findJob).toHaveBeenCalledTimes(6);
      expect(statusUpdate).toHaveBeenCalledOnce();
    });

    it('still shows the card when reading the job back fails', async () => {
      const findJob = vi.fn().mockRejectedValue(new Error('db down'));
      const { tool, statusUpdate, logger } = build(vi.fn().mockResolvedValue(runningJob), { findJob });
      expect(JSON.parse(await call(tool))).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
      expect(statusUpdate).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });
});

describe('music_generation model admission', () => {
  it('returns a free-tier refusal from the job engine as the tool result, logged at warn', async () => {
    const refusal = new ForbiddenError('Model "test-music" requires a paid plan.', {
      errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
    });
    const { tool, statusUpdate, logger } = build(vi.fn().mockRejectedValue(refusal));
    await expect(tool.toolFn({ model: 'test-music', prompt: 'a sea shanty' })).resolves.toBe(
      'Error: Model "test-music" requires a paid plan.'
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[music_generation]'), { modelId: 'test-music' });
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('still throws any other job-engine failure', async () => {
    const failure = new Error('database unavailable');
    const { tool, logger } = build(vi.fn().mockRejectedValue(failure));
    await expect(tool.toolFn({ model: 'test-music', prompt: 'a sea shanty' })).rejects.toBe(failure);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
