import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioJobOutput, IGenerationJobDocument, StorageLimitErrorInfo } from '@bike4mind/common';
import type { CreateAudioJobResult } from '@bike4mind/services/audioJobs';

const { fabFileFindById } = vi.hoisted(() => ({ fabFileFindById: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  fabFileRepository: { findById: (...a: unknown[]) => fabFileFindById(...a) },
}));

import {
  createAudioJobKeepingAudioOnFullQuota,
  isRateLimitedFailure,
  providerStatusOf,
  retryAfterSecondsOf,
  savedCopyOf,
} from './syncAudioJob';

type Result = CreateAudioJobResult<{ id: string }>;

const created: Result = { ok: true, job: { id: 'job-1' }, created: true };

const quotaRefusal = (errorCode: StorageLimitErrorInfo['errorCode']): Result => ({
  ok: false,
  status: 400,
  code: 'storage_quota_exceeded',
  message: 'Not enough free file storage',
  storage: { errorCode } as StorageLimitErrorInfo,
});

const failedJob = (error: IGenerationJobDocument['error'], state: IGenerationJobDocument['state'] = 'failed') =>
  ({ id: 'job-1', kind: 'speech', state, error }) as IGenerationJobDocument;

const filesOutput: AudioJobOutput = {
  location: 'files',
  s3Key: 'files/clip.mp3',
  fileId: 'fab-1',
  contentType: 'audio/mpeg',
  bytes: 3,
};

beforeEach(() => {
  fabFileFindById.mockReset();
});

describe('createAudioJobKeepingAudioOnFullQuota', () => {
  it('creates once with the saved copy when the quota allows it', async () => {
    const create = vi.fn(async () => created);
    expect(await createAudioJobKeepingAudioOnFullQuota(create, true)).toEqual({ result: created, saveToFiles: true });
    expect(create).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    ['file_too_large', 'file_too_large'],
    ['storage_limit_exceeded', 'storage_limit'],
  ] as const)('retries without the saved copy on a full quota (%s), reporting %s', async (errorCode, reason) => {
    const create = vi.fn(async (saveToFiles: boolean) => (saveToFiles ? quotaRefusal(errorCode) : created));
    expect(await createAudioJobKeepingAudioOnFullQuota(create, true)).toEqual({
      result: created,
      saveToFiles: false,
      quotaSkip: { saved: false, reason },
    });
    expect(create.mock.calls).toEqual([[true], [false]]);
  });

  it.each<Result>([
    { ok: false, status: 402, code: 'insufficient_credits', message: 'broke' },
    { ok: false, status: 422, code: 'invalid_request', message: 'bad' },
    { ok: false, status: 429, code: 'daily_limit_reached', message: 'capped', retryAfterSeconds: 60 },
  ])('does not retry a $code refusal', async refusal => {
    const create = vi.fn(async () => refusal);
    expect(await createAudioJobKeepingAudioOnFullQuota(create, true)).toEqual({ result: refusal, saveToFiles: true });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('savedCopyOf', () => {
  it('reports nothing when no saved copy was asked for', async () => {
    expect(await savedCopyOf(filesOutput, false)).toBeUndefined();
    expect(fabFileFindById).not.toHaveBeenCalled();
  });

  it('reports the saved file', async () => {
    fabFileFindById.mockResolvedValue({ fileName: 'clip.mp3', fileUrl: 'https://s3/get' });
    expect(await savedCopyOf(filesOutput, true)).toEqual({
      saved: true,
      fileId: 'fab-1',
      s3Key: 'files/clip.mp3',
      fileName: 'clip.mp3',
      fileUrl: 'https://s3/get',
    });
  });

  it('reports a failed save when the Files write fell back to the generated bucket', async () => {
    const generated: AudioJobOutput = {
      location: 'generated',
      s3Key: 'generated-audio/u1/job-1.mp3',
      contentType: 'audio/mpeg',
      bytes: 3,
    };
    expect(await savedCopyOf(generated, true)).toEqual({ saved: false, reason: 'error' });
    expect(fabFileFindById).not.toHaveBeenCalled();
  });

  it('reports a failed save when the saved file is gone', async () => {
    fabFileFindById.mockResolvedValue(null);
    expect(await savedCopyOf(filesOutput, true)).toEqual({ saved: false, reason: 'error' });
  });
});

describe('rate-limited failures', () => {
  // The shape the speech and sound-effect handlers record (rateLimitedStep in services audioJobs/shared.ts).
  const rateLimited = failedJob({
    code: 'provider_error',
    message: 'elevenlabs is at capacity (upstream_rate_limited); retry in 4s',
    providerStatus: 429,
    retryAfterSeconds: 4,
  });

  it('recognises the handlers rate-limited failure and its Retry-After', () => {
    expect(isRateLimitedFailure(rateLimited)).toBe(true);
    expect(providerStatusOf(rateLimited)).toBe(429);
    expect(retryAfterSecondsOf(rateLimited)).toBe(4);
  });

  it('falls back to a default Retry-After when the failure recorded none', () => {
    expect(retryAfterSecondsOf(failedJob({ code: 'provider_error', message: 'x', providerStatus: 429 }))).toBe(30);
  });

  it.each([
    ['another provider status', failedJob({ code: 'provider_error', message: 'x', providerStatus: 401 })],
    ['a message that only looks rate limited', failedJob({ code: 'provider_error', message: 'openai_rate_limited' })],
    ['an unknown outcome', failedJob({ code: 'orphaned_submit', message: 'timeout' })],
    ['a job that did not fail', failedJob({ code: 'content_blocked', message: 'x', providerStatus: 429 }, 'blocked')],
  ])('does not treat %s as rate limited', (_label, job) => {
    expect(isRateLimitedFailure(job)).toBe(false);
  });

  it('reads the provider status from the job error, since rawProviderError is never read back', () => {
    const job = { ...failedJob({ code: 'provider_error', message: 'x' }), rawProviderError: { status: 429 } };
    expect(providerStatusOf(job)).toBeUndefined();
  });
});
