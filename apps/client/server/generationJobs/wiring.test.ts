import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IGenerationJobDocument, VideoProviderId } from '@bike4mind/common';

const { queueLink, getSourceQueueUrl, sendToQueue } = vi.hoisted(() => ({
  queueLink: { mode: 'direct' as 'direct' | 'throws' },
  getSourceQueueUrl: vi.fn(),
  sendToQueue: vi.fn(),
}));

// A getter mirrors sst's Resource proxy, which throws when a key is not linked to the Lambda.
vi.mock('sst', () => ({
  Resource: {
    websocket: { managementEndpoint: 'https://ws.example.test' },
    get generationJobQueue(): { url: string } {
      if (queueLink.mode === 'throws') throw new Error('generationJobQueue is not linked');
      return { url: 'https://sqs.example.test/direct' };
    },
  },
}));
vi.mock('@server/utils/dlqRegistry', () => ({ getSourceQueueUrl }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(),
  getGeneratedImageStorage: vi.fn(),
}));
// No stored keys needed: a database round trip here would only slow the test down.
vi.mock('@bike4mind/auth', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/auth')>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
  };
});
vi.mock('@server/utils/sqs', () => ({ sendToQueue }));

import { enqueueGenerationJob, getVideoJobDeps, selectProviderKey, toJobUpdate, usableApiKey } from './wiring';

const baseJob = {
  id: 'job1',
  kind: 'video',
  state: 'running',
  requestedBy: 'user1',
  creditHold: { reservedCredits: 10 },
  rawProviderError: { secret: 'internal' },
  payload: { providerId: 'test', request: { model: 'm' } },
} as unknown as IGenerationJobDocument;

describe('usableApiKey', () => {
  it('returns a real key unchanged', () => {
    expect(usableApiKey('sk-live')).toBe('sk-live');
  });

  it.each([null, undefined, ''])('maps a missing or empty key (%j) to null', raw => {
    expect(usableApiKey(raw)).toBeNull();
  });

  it('maps the expired sentinel to null so it never reaches a provider call', () => {
    expect(usableApiKey('expired')).toBeNull();
  });
});

describe('provider key selection', () => {
  it('gives the test provider a fixed key without consulting stored keys', () => {
    expect(selectProviderKey('test', {} as never)).toBe('test-key');
  });

  it('maps gemini-omni to the Gemini key', () => {
    expect(selectProviderKey('gemini-omni', { gemini: 'g-key' } as never)).toBe('g-key');
    expect(usableApiKey(selectProviderKey('gemini-omni', { gemini: null } as never))).toBeNull();
  });

  it('throws for a provider id with no mapping', () => {
    expect(() => selectProviderKey('unmapped' as VideoProviderId, {} as never)).toThrow(/no API key mapping/);
  });

  it('resolves the test provider key through the deps', async () => {
    const apiKey = await getVideoJobDeps().resolveApiKey('test', 'user1');
    expect(apiKey).toBe('test-key');
  });
});

describe('toJobUpdate', () => {
  it('never exposes internal fields', () => {
    const update = toJobUpdate(baseJob);
    expect(update).toEqual({
      action: 'generation_job_updated',
      job: { id: 'job1', kind: 'video', state: 'running' },
    });
    expect(JSON.stringify(update)).not.toContain('secret');
    expect(JSON.stringify(update)).not.toContain('creditHold');
  });

  it('includes output.fileId only when present', () => {
    const withFile = toJobUpdate({
      ...baseJob,
      state: 'succeeded',
      payload: { ...baseJob.payload, output: { contentType: 'video/mp4', durationSeconds: 4, fileId: 'f1' } },
    } as IGenerationJobDocument);
    expect(withFile.job.output).toEqual({ fileId: 'f1', contentType: 'video/mp4', durationSeconds: 4 });

    const withoutFile = toJobUpdate({
      ...baseJob,
      state: 'succeeded',
      payload: { ...baseJob.payload, output: { contentType: 'video/mp4', durationSeconds: 4 } },
    } as IGenerationJobDocument);
    expect(withoutFile.job.output).toEqual({ contentType: 'video/mp4', durationSeconds: 4 });
  });

  it('carries progress and the error code and message', () => {
    const update = toJobUpdate({
      ...baseJob,
      state: 'failed',
      progress: 0.5,
      error: { code: 'provider_error', message: 'boom' },
    } as IGenerationJobDocument);
    expect(update.job).toMatchObject({ progress: 0.5, error: { code: 'provider_error', message: 'boom' } });
  });
});

describe('enqueueGenerationJob queue URL resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueLink.mode = 'direct';
    getSourceQueueUrl.mockReturnValue('https://sqs.example.test/registry');
  });

  it('prefers the directly linked queue and passes the delay through unchanged', async () => {
    await enqueueGenerationJob('job1', 30);
    expect(sendToQueue).toHaveBeenCalledWith('https://sqs.example.test/direct', { jobId: 'job1' }, 30);
    expect(getSourceQueueUrl).not.toHaveBeenCalled();
  });

  it('falls back to the sourceQueueUrls registry when the queue is not linked directly', async () => {
    queueLink.mode = 'throws';
    await enqueueGenerationJob('job2', 0);
    expect(sendToQueue).toHaveBeenCalledWith('https://sqs.example.test/registry', { jobId: 'job2' }, 0);
  });

  it('rejects loudly, without sending, when neither source resolves a URL', async () => {
    queueLink.mode = 'throws';
    getSourceQueueUrl.mockImplementation(() => {
      throw new Error('Missing source queue URL for: generationJobQueue.');
    });
    await expect(enqueueGenerationJob('job3', 5)).rejects.toThrow('Missing source queue URL');
    expect(sendToQueue).not.toHaveBeenCalled();
  });
});
