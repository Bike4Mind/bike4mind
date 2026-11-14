import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, type IGenerationJobDocumentOf, type VideoJobOutput } from '@bike4mind/common';
import { generationJobErrorCopy } from './generationJobErrorCopy';
import { toPublicGenerationJob } from './toPublicGenerationJob';

type Job = IGenerationJobDocumentOf<'video'>;

const output: VideoJobOutput = {
  location: 'files',
  s3Key: 'k',
  fileId: 'f1',
  contentType: 'video/mp4',
  bytes: 1,
  durationSeconds: 2,
};

const job = (overrides: Partial<Job> = {}): Job =>
  ({
    id: 'j1',
    kind: 'video',
    ownerType: CreditHolderType.User,
    ownerId: 'u1',
    requestedBy: 'u1',
    source: 'studio',
    state: 'succeeded',
    payload: { request: { prompt: 'p' }, providerId: 'x', output },
    pollCount: 0,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T00:20:00Z'),
    createdAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: new Date('2026-10-06T00:01:00Z'),
    ...overrides,
  }) as Job;

// A made-up kind, so these pin the shared envelope rather than any published resource.
const projection = {
  object: 'test_generation' as const,
  toPublicErrorCode: () => 'provider_error' as const,
  errorCopy: generationJobErrorCopy({ noun: 'thing', plural: 'things' }),
  requestFields: (j: Job) => ({ prompt: j.payload.request.prompt }),
  statusFields: () => ({ stage: 'late' }),
  outputOf: (j: Job) => j.payload.output,
  outputFields: (o: VideoJobOutput) => ({ bytes: o.bytes }),
};

const now = () => new Date('2026-10-06T00:02:00Z');
const ready = { sign: vi.fn(async () => ({ availability: 'ready' as const, url: 'https://u' })), now };

describe('toPublicGenerationJob', () => {
  it('places each kind hook where the projection says, in a stable key order', async () => {
    const resource = await toPublicGenerationJob(job(), ready, projection);
    expect(Object.keys(resource)).toEqual([
      'id',
      'object',
      'state',
      'prompt',
      'source',
      'stage',
      'error',
      'output',
      'credits',
      'created_at',
      'updated_at',
    ]);
    expect(Object.keys(resource.output ?? {})).toEqual([
      'availability',
      'url',
      'expires_at',
      'content_type',
      'bytes',
      'file_id',
    ]);
  });

  it('renders the folded code with the fixed copy, never the stored message', async () => {
    const failed = job({ state: 'failed', error: { code: 'orphaned_submit', message: 'provider says secret' } });
    const resource = await toPublicGenerationJob(failed, ready, projection);
    expect(resource.error).toEqual({ code: 'provider_error', message: 'The provider failed to generate the thing.' });
    expect(JSON.stringify(resource)).not.toContain('secret');
  });

  it('signs only a succeeded job', async () => {
    const sign = vi.fn();
    const resource = await toPublicGenerationJob(job({ state: 'storing' }), { sign, now }, projection);
    expect(resource.output).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('withholds the url of an output that is not ready', async () => {
    const pending = { sign: async () => ({ availability: 'pending_scan' as const }), now };
    const resource = await toPublicGenerationJob(job(), pending, projection);
    expect(resource.output).toMatchObject({ availability: 'pending_scan', url: null, expires_at: null });
  });

  it('reports a missing hold or settlement as null credits', async () => {
    const resource = await toPublicGenerationJob(job(), ready, projection);
    expect(resource.credits).toEqual({ reserved: null, settled: null });
  });
});
