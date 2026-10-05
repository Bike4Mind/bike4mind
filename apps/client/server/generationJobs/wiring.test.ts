import { describe, expect, it, vi } from 'vitest';
import type { IGenerationJobDocument, VideoProviderId } from '@bike4mind/common';

vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'https://ws.example.test' } } }));
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
vi.mock('@server/utils/sqs', () => ({ sendToQueue: vi.fn() }));

import { getVideoJobDeps, selectProviderKey, toJobUpdate, usableApiKey } from './wiring';

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
