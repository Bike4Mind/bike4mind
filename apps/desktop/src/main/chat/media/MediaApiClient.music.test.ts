import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { MediaApiClient, type MediaToolError } from './MediaApiClient';

const model = {
  id: 'lyria-3.5',
  object: 'music_model',
  display_name: 'Lyria 3.5',
  provider: 'google',
  vocals: 'optional',
  lyrics: null,
  duration: { control: 'approximate', min: 10, max: 180, default: 60 },
  output_formats: ['mp3'],
  typical_render_seconds: 60,
  pricing: { unit: 'per_song', credits: 10 },
  preview: false,
  deprecation_date: null,
};

const jobBody = {
  id: 'job 1',
  object: 'music_generation',
  state: 'pending',
  model: 'lyria-3.5',
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

function clientWith(api: { get?: unknown; post?: unknown }) {
  return new MediaApiClient(api as unknown as AuthenticatedApiClient);
}

describe('music job client', () => {
  it('lists models from /api/v1/music-models', async () => {
    const get = vi.fn().mockResolvedValue({ models: [model] });
    const models = await clientWith({ get }).listMusicModels();
    expect(get.mock.calls[0][0]).toBe('/api/v1/music-models');
    expect(models[0].display_name).toBe('Lyria 3.5');
  });

  it('posts the job with an Idempotency-Key header and parses the result', async () => {
    const post = vi.fn().mockResolvedValue(jobBody);
    const job = await clientWith({ post }).createMusicGeneration({ model: 'lyria-3.5', prompt: 'p' }, 'key-1');
    expect(post.mock.calls[0][0]).toBe('/api/v1/music-generations');
    expect(post.mock.calls[0][2].headers).toEqual({ 'Idempotency-Key': 'key-1' });
    expect(job.state).toBe('pending');
  });

  it('reads a job by encoded id and forwards the abort signal', async () => {
    const get = vi.fn().mockResolvedValue(jobBody);
    const signal = new AbortController().signal;
    await clientWith({ get }).getMusicGeneration('job 1', signal);
    expect(get.mock.calls[0][0]).toBe('/api/v1/music-generations/job%201');
    expect(get.mock.calls[0][1].signal).toBe(signal);
  });

  it('cancels a job by encoded id', async () => {
    const post = vi.fn().mockResolvedValue({ ...jobBody, state: 'cancelled' });
    const job = await clientWith({ post }).cancelMusicGeneration('job 1');
    expect(post.mock.calls[0][0]).toBe('/api/v1/music-generations/job%201/cancel');
    expect(job.state).toBe('cancelled');
  });

  it('rejects a response that does not parse as a music job', async () => {
    const get = vi.fn().mockResolvedValue({ id: 'x' });
    await expect(clientWith({ get }).getMusicGeneration('x')).rejects.toThrow();
  });

  it('keeps the status and the Retry-After a rate-limited read came back with', async () => {
    const response = {
      status: 429,
      data: { error: 'Rate limit exceeded. Try again in 45 seconds.' },
      statusText: '',
      headers: new AxiosHeaders({ 'retry-after': '45' }),
      config: { headers: new AxiosHeaders() },
    };
    const get = vi.fn().mockRejectedValue(new AxiosError('rejected', '429', undefined, undefined, response));
    const error = (await clientWith({ get })
      .getMusicGeneration('x')
      .catch((e: unknown) => e)) as MediaToolError;

    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(45_000);
  });
});
