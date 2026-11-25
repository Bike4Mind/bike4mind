import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { MediaApiClient, MediaToolError } from './MediaApiClient';

describe('image', () => {
  const jobBody = {
    id: 'job 1',
    object: 'image_generation',
    state: 'pending',
    model: 'gpt-image-2',
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

  function clientWith(api: { get?: unknown; post?: unknown }) {
    return new MediaApiClient(api as unknown as AuthenticatedApiClient);
  }

  describe('image job client', () => {
    it('posts the job with an Idempotency-Key header and returns the created jobs', async () => {
      const post = vi.fn().mockResolvedValue({ group_id: 'grp1', data: [jobBody] });
      const jobs = await clientWith({ post }).createImageJob(
        { model: 'gpt-image-2', mode: 'generate', prompt: 'p', count: 1 },
        'key-1'
      );
      expect(post.mock.calls[0][0]).toBe('/api/v1/image-jobs');
      expect(post.mock.calls[0][2].headers).toEqual({ 'Idempotency-Key': 'key-1' });
      expect(jobs).toHaveLength(1);
      expect(jobs[0].state).toBe('pending');
    });

    it('returns the group id beside the jobs for a multi-image submit', async () => {
      const post = vi.fn().mockResolvedValue({ group_id: 'grp1', data: [jobBody, { ...jobBody, id: 'job 2' }] });
      const group = await clientWith({ post }).createImageJobGroup(
        { model: 'gpt-image-2', mode: 'generate', prompt: 'p', count: 2 },
        'key-2'
      );
      expect(post.mock.calls[0][1]).toMatchObject({ count: 2 });
      expect(group.group_id).toBe('grp1');
      expect(group.data.map(job => job.id)).toEqual(['job 1', 'job 2']);
    });

    it('rejects a create response that is not the public image-job shape', async () => {
      // The retired Studio route answered { groupId, jobs }; reading it as v1 must fail loudly, not as zero jobs.
      const post = vi.fn().mockResolvedValue({ groupId: 'grp1', jobs: [jobBody] });
      await expect(
        clientWith({ post }).createImageJobGroup({ model: 'gpt-image-2', mode: 'generate', prompt: 'p' }, 'key-3')
      ).rejects.toThrow();
    });

    it('surfaces a 422 insufficient_credits refusal as a credits notice', async () => {
      const response = {
        status: 422,
        statusText: 'Unprocessable Entity',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { error: 'Not enough credits for 2 images.', errorCode: 'insufficient_credits' },
      };
      const post = vi.fn().mockRejectedValue(new AxiosError('422', 'ERR_BAD_REQUEST', undefined, undefined, response));
      const error = await clientWith({ post })
        .createImageJobGroup({ model: 'gpt-image-2', mode: 'generate', prompt: 'p' }, 'key-4')
        .catch((caught: unknown) => caught);
      if (!(error instanceof MediaToolError)) throw new Error('expected a MediaToolError');
      expect(error).toMatchObject({ status: 422, code: 'insufficient_credits' });
      expect(error.message).toContain('Not enough credits');
      expect(error.notice).toMatchObject({ kind: 'insufficient-credits' });
    });

    it('reads a job by encoded id and forwards the abort signal', async () => {
      const get = vi.fn().mockResolvedValue(jobBody);
      const signal = new AbortController().signal;
      await clientWith({ get }).getImageJob('job 1', signal);
      expect(get.mock.calls[0][0]).toBe('/api/v1/image-jobs/job%201');
      expect(get.mock.calls[0][1].signal).toBe(signal);
    });

    it('cancels a job by encoded id', async () => {
      const post = vi.fn().mockResolvedValue({ ...jobBody, state: 'cancelled' });
      const job = await clientWith({ post }).cancelImageJob('job 1');
      expect(post.mock.calls[0][0]).toBe('/api/v1/image-jobs/job%201/cancel');
      expect(job.state).toBe('cancelled');
    });

    it('rejects a response that does not parse as an image job', async () => {
      const get = vi.fn().mockResolvedValue({ id: 'x' });
      await expect(clientWith({ get }).getImageJob('x')).rejects.toThrow();
    });

    it('maps a 422 insufficient_credits on create to the credits notice', async () => {
      const response = {
        status: 422,
        data: { error: 'Not enough credits.', errorCode: 'insufficient_credits' },
        statusText: '',
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() },
      };
      const post = vi.fn().mockRejectedValue(new AxiosError('rejected', '422', undefined, undefined, response));
      const error = (await clientWith({ post })
        .createImageJob({ model: 'gpt-image-2', mode: 'generate', prompt: 'p' }, 'k')
        .catch((e: unknown) => e)) as MediaToolError;

      expect(error.notice?.kind).toBe('insufficient-credits');
      expect(error.status).toBe(422);
    });
  });
});

describe('music', () => {
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
});
