import { describe, expect, it, vi } from 'vitest';
import type { GenerationJobState } from '@bike4mind/common';
import { createProductionAudio, MP3_TAIL_MARGIN_MS } from './audio';
import type { ProductionAudioSettings } from './config';

const FILE_ID = 'a'.repeat(24);

const makeContext = () =>
  ({
    userId: 'user1',
    questId: 'quest1',
    user: { isAdmin: false },
    statusUpdate: vi.fn(async () => undefined),
  }) as never;

const created = (id: string, state: GenerationJobState, isNew = true) => ({
  ok: true as const,
  created: isNew,
  job: { id, state },
});

const finished = (kind: 'speech' | 'sound_effect', output: { fileId?: string; durationSeconds?: number }) => ({
  id: 'job',
  kind,
  state: 'succeeded',
  payload: { output },
});

const makeJobs = (overrides: Partial<ProductionAudioSettings['jobs']> = {}): ProductionAudioSettings['jobs'] =>
  ({
    createSpeechJob: vi.fn(async () => created('speech-job', 'queued')),
    createSoundEffectJob: vi.fn(async () => created('sfx-job', 'queued')),
    runInline: vi.fn(async () => null),
    readOutput: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  }) as unknown as ProductionAudioSettings['jobs'];

describe('createProductionAudio', () => {
  it('starts a speech job with a decodable container, posts its card and returns the saved clip', async () => {
    const jobs = makeJobs({
      runInline: vi.fn(async () => finished('speech', { fileId: FILE_ID, durationSeconds: 2.5 })),
    });
    const context = makeContext();
    const audio = createProductionAudio(context, { voice: 'nova', jobs });

    const result = await audio.speech({ text: 'Meet the bottle that keeps up.' });

    expect(result).toEqual({ ok: true, fileId: FILE_ID, durationMs: 2500 - MP3_TAIL_MARGIN_MS });
    const [input] = vi.mocked(jobs.createSpeechJob).mock.calls[0]!;
    expect(input.request).toMatchObject({ text: 'Meet the bottle that keeps up.', voice: 'nova', format: 'mp3' });
    expect(input).toMatchObject({ source: 'agent', saveToFiles: true, questId: 'quest1' });
    expect((context as { statusUpdate: ReturnType<typeof vi.fn> }).statusUpdate).toHaveBeenCalledWith(
      {},
      'Generating voiceover...'
    );
  });

  it('starts a sound effect job for the asked length and falls back to it when the output has none', async () => {
    const jobs = makeJobs({ runInline: vi.fn(async () => finished('sound_effect', { fileId: FILE_ID })) });
    const audio = createProductionAudio(makeContext(), { jobs });

    const result = await audio.soundEffect({ prompt: 'a cap pops', durationSeconds: 1.5 });

    expect(result).toEqual({ ok: true, fileId: FILE_ID, durationMs: 1500 - MP3_TAIL_MARGIN_MS });
    const [input] = vi.mocked(jobs.createSoundEffectJob).mock.calls[0]!;
    expect(input.request).toMatchObject({ provider: 'elevenlabs', text: 'a cap pops', durationSeconds: 1.5 });
  });

  it('never places a sound effect longer than the length it asked for', async () => {
    // The measured length counts the mp3's padding frames, here 42 ms past the 5 s file the editor plays.
    const jobs = makeJobs({
      runInline: vi.fn(async () => finished('sound_effect', { fileId: FILE_ID, durationSeconds: 5.042 })),
    });
    const audio = createProductionAudio(makeContext(), { jobs });

    const result = await audio.soundEffect({ prompt: 'a closing chime', durationSeconds: 5 });

    expect(result).toEqual({ ok: true, fileId: FILE_ID, durationMs: 5000 - MP3_TAIL_MARGIN_MS });
  });

  it('reports a clip still running at the inline timeout as pending', async () => {
    const audio = createProductionAudio(makeContext(), { jobs: makeJobs() });
    await expect(audio.speech({ text: 'hello' })).resolves.toMatchObject({ ok: false, code: 'pending' });
  });

  it('reports a finished clip that was not saved to Files', async () => {
    const jobs = makeJobs({ runInline: vi.fn(async () => finished('speech', { durationSeconds: 1 })) });
    const audio = createProductionAudio(makeContext(), { jobs });
    await expect(audio.speech({ text: 'hello' })).resolves.toMatchObject({ ok: false, code: 'not_saved' });
  });

  it('passes a cap refusal through as a failure the model can read', async () => {
    const jobs = makeJobs({
      createSpeechJob: vi.fn(async () => ({ ok: false, code: 'limit_reached', message: 'too many clips this run' })),
    } as never);
    const audio = createProductionAudio(makeContext(), { jobs });
    await expect(audio.speech({ text: 'hello' })).resolves.toEqual({
      ok: false,
      code: 'limit_reached',
      message: 'too many clips this run',
    });
    expect(jobs.runInline).not.toHaveBeenCalled();
  });

  it('moves past a replay of a failed job under a new key, and gives up after the last attempt', async () => {
    const retried = makeJobs({
      createSpeechJob: vi
        .fn()
        .mockResolvedValueOnce(created('dead', 'failed', false))
        .mockResolvedValueOnce(created('fresh', 'queued')),
    } as never);
    await createProductionAudio(makeContext(), { jobs: retried }).speech({ text: 'hello' });
    const keys = vi.mocked(retried.createSpeechJob).mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(retried.runInline).toHaveBeenCalledWith('fresh', expect.any(Object));

    const dead = makeJobs({ createSpeechJob: vi.fn(async () => created('dead', 'failed', false)) } as never);
    const result = await createProductionAudio(makeContext(), { jobs: dead }).speech({ text: 'hello' });
    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(dead.createSpeechJob).toHaveBeenCalledTimes(3);
    expect(dead.runInline).not.toHaveBeenCalled();
  });

  it('ends the turn when the user is out of credits', async () => {
    const jobs = makeJobs({
      createSoundEffectJob: vi.fn(async () => ({ ok: false, code: 'insufficient_credits', message: 'no credits' })),
    } as never);
    const audio = createProductionAudio(makeContext(), { jobs });
    await expect(audio.soundEffect({ prompt: 'whoosh', durationSeconds: 1 })).rejects.toThrow();
  });
});
