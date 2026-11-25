import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { CompletionRunAttribution } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { RunBudgetExhaustedError, RunNotFoundError } from '../completions';
import { MediaApiClient, type MediaRun } from './MediaApiClient';

const RUN: CompletionRunAttribution = { runId: 'run-1', role: 'worker', purpose: 'turn', taskId: 'task-a' };
const TOOL_RUN = { ...RUN, purpose: 'tool' };

const refusal = (status: number, body: Record<string, unknown>, asBytes = false) =>
  Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    response: {
      status,
      headers: {},
      data: asBytes ? new TextEncoder().encode(JSON.stringify(body)).buffer : body,
    },
  });
const exhausted = (asBytes?: boolean) =>
  refusal(422, { error: 'Run budget used up', errorCode: 'run_budget_exhausted' }, asBytes);
const notFound = () => refusal(404, { error: 'Run not found', errorCode: 'run_not_found' });

const musicJob = {
  id: 'job-m',
  object: 'music_generation',
  state: 'pending',
  model: 'm',
  prompt: 'p',
  lyrics: null,
  instrumental: false,
  duration_seconds: 60,
  source: 'agent',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: 'x',
  updated_at: 'x',
};
const videoJob = {
  id: 'job-v',
  object: 'video_generation',
  state: 'pending',
  model: 'v',
  mode: 'text_to_video',
  prompt: 'p',
  duration_seconds: 6,
  aspect_ratio: '16:9',
  resolution: '720p',
  source: 'agent',
  progress: null,
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: 'x',
  updated_at: 'x',
};

const imageJob = {
  id: 'job-i',
  object: 'image_generation',
  state: 'pending',
  model: 'gpt-image-1-mini',
  mode: 'generate',
  prompt: 'p',
  group_id: 'grp1',
  source: 'agent',
  error: null,
  output: null,
  credits: { reserved: null, settled: null },
  created_at: 'x',
  updated_at: 'x',
};
const imageBody = { model: 'gpt-image-1-mini', mode: 'generate' as const, prompt: 'p', count: 1 };

const speech = { audio: 'AAAA', contentType: 'audio/mpeg', format: 'mp3' };

function clientWith(api: { post?: unknown; axiosPost?: unknown }, run?: MediaRun) {
  return new MediaApiClient(
    {
      post: api.post,
      getAxiosInstance: () => ({ post: api.axiosPost }),
    } as unknown as AuthenticatedApiClient,
    run
  );
}
const runOf = (budgeted = false, current: CompletionRunAttribution | undefined = RUN): MediaRun => ({
  current: () => current,
  budgeted,
  onRejected: vi.fn().mockResolvedValue(undefined),
});

describe('paid media calls inside an orchestration run', () => {
  it('sends the run as a tool call on every paid request', async () => {
    const post = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/ai/tts') return Promise.resolve(speech);
      if (path === '/api/v1/music-generations') return Promise.resolve(musicJob);
      if (path === '/api/v1/video-generations') return Promise.resolve(videoJob);
      if (path === '/api/v1/image-jobs') return Promise.resolve({ group_id: 'grp1', data: [imageJob] });
      return Promise.reject(new Error(`unexpected ${path}`));
    });
    const axiosPost = vi.fn().mockResolvedValue({ data: new ArrayBuffer(2), headers: {} });
    const client = clientWith({ post, axiosPost }, runOf());

    await client.synthesizeSpeech({ text: 'hello', provider: 'openai' } as never);
    await client.generateSoundEffect({ text: 'rain' } as never);
    await client.createMusicGeneration({ model: 'm', prompt: 'p' }, 'key-1');
    await client.createVideoGeneration({ model: 'v', prompt: 'p' } as never, 'key-2');
    await client.createImageJob(imageBody, 'key-3');

    const bodies = [...post.mock.calls, ...axiosPost.mock.calls].map(call => call[1] as { run?: unknown });
    expect(bodies).toHaveLength(5);
    for (const body of bodies) expect(body.run).toEqual(TOOL_RUN);
  });

  it('sends no run outside one', async () => {
    const post = vi.fn().mockResolvedValue(speech);
    await clientWith({ post }).synthesizeSpeech({ text: 'hello', provider: 'openai' } as never);
    expect(post.mock.calls[0][1]).not.toHaveProperty('run');
  });

  it('turns a budget refusal into RunBudgetExhaustedError, for JSON and raw-bytes routes alike', async () => {
    const client = clientWith(
      { post: vi.fn().mockRejectedValue(exhausted()), axiosPost: vi.fn().mockRejectedValue(exhausted(true)) },
      runOf(true)
    );

    await expect(client.synthesizeSpeech({ text: 'hi', provider: 'openai' } as never)).rejects.toBeInstanceOf(
      RunBudgetExhaustedError
    );
    await expect(client.generateSoundEffect({ text: 'rain' } as never)).rejects.toBeInstanceOf(RunBudgetExhaustedError);
  });

  it('turns a budget refusal on the image, video and music submits into RunBudgetExhaustedError', async () => {
    const client = clientWith({ post: vi.fn().mockRejectedValue(exhausted()) }, runOf(true));

    await expect(client.createVideoGeneration({ model: 'v', prompt: 'p' } as never, 'key-v')).rejects.toBeInstanceOf(
      RunBudgetExhaustedError
    );
    await expect(client.createMusicGeneration({ model: 'm', prompt: 'p' }, 'key-m')).rejects.toBeInstanceOf(
      RunBudgetExhaustedError
    );
    await expect(client.createImageJob(imageBody, 'key-i')).rejects.toBeInstanceOf(RunBudgetExhaustedError);
  });

  it('keeps the Idempotency-Key on an image job submit, including the unattributed resend', async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce({ group_id: 'grp1', data: [imageJob] });
    const run = runOf(false);

    await clientWith({ post }, run).createImageJob(imageBody, 'key-i');

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1]).toMatchObject({ run: TOOL_RUN });
    expect(post.mock.calls[1][1]).not.toHaveProperty('run');
    expect(post.mock.calls.map(call => (call[2] as { headers: unknown }).headers)).toEqual([
      { 'Idempotency-Key': 'key-i' },
      { 'Idempotency-Key': 'key-i' },
    ]);
    expect(run.onRejected).toHaveBeenCalledTimes(1);
  });

  it('keeps the Idempotency-Key on video and music submits, including the unattributed resend', async () => {
    const post = vi
      .fn()
      .mockImplementation((path: string) =>
        Promise.resolve(path === '/api/v1/music-generations' ? musicJob : videoJob)
      );
    const client = clientWith({ post }, runOf());
    await client.createVideoGeneration({ model: 'v', prompt: 'p' } as never, 'key-v');
    await client.createMusicGeneration({ model: 'm', prompt: 'p' }, 'key-m');
    expect(post.mock.calls.map(call => (call[2] as { headers: unknown }).headers)).toEqual([
      { 'Idempotency-Key': 'key-v' },
      { 'Idempotency-Key': 'key-m' },
    ]);

    const resend = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(videoJob)
      .mockRejectedValueOnce(notFound())
      .mockResolvedValueOnce(musicJob);
    const unattributed = clientWith({ post: resend }, runOf(false));
    await unattributed.createVideoGeneration({ model: 'v', prompt: 'p' } as never, 'key-v');
    await unattributed.createMusicGeneration({ model: 'm', prompt: 'p' }, 'key-m');
    expect(resend).toHaveBeenCalledTimes(4);
    for (const index of [1, 3]) expect(resend.mock.calls[index][1]).not.toHaveProperty('run');
    expect(resend.mock.calls.map(call => (call[2] as { headers: unknown }).headers)).toEqual([
      { 'Idempotency-Key': 'key-v' },
      { 'Idempotency-Key': 'key-v' },
      { 'Idempotency-Key': 'key-m' },
      { 'Idempotency-Key': 'key-m' },
    ]);
  });

  it('resends an unbudgeted call without the run the server no longer knows, and forgets it', async () => {
    const post = vi.fn().mockRejectedValueOnce(notFound()).mockResolvedValueOnce(speech);
    const run = runOf(false);

    await clientWith({ post }, run).synthesizeSpeech({ text: 'hello', provider: 'openai' } as never);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][1]).not.toHaveProperty('run');
    expect(run.onRejected).toHaveBeenCalledTimes(1);
  });

  it('never resends a budgeted call unattributed', async () => {
    const post = vi.fn().mockRejectedValue(notFound());

    await expect(
      clientWith({ post }, runOf(true)).synthesizeSpeech({ text: 'hello', provider: 'openai' } as never)
    ).rejects.toBeInstanceOf(RunNotFoundError);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reads the run at call time, so one the turn has dropped is not sent', async () => {
    const post = vi.fn().mockResolvedValue(speech);
    await clientWith({ post }, { ...runOf(), current: () => undefined }).synthesizeSpeech({
      text: 'hi',
      provider: 'openai',
    } as never);
    expect(post.mock.calls[0][1]).not.toHaveProperty('run');
  });
});
