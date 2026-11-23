import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { MediaApiClient, type MediaToolError } from './MediaApiClient';

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
