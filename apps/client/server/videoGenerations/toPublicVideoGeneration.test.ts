import { describe, expect, it, vi } from 'vitest';
import { CreditHolderType, VideoGenerationSchema, type IGenerationJobDocument } from '@bike4mind/common';
import { OUTPUT_URL_TTL_SECONDS, toPublicVideoGeneration } from './toPublicVideoGeneration';

const job = (overrides: Partial<IGenerationJobDocument> = {}): IGenerationJobDocument =>
  ({
    id: '664f1c2b9a1e4d0012ab34cd',
    kind: 'video',
    ownerType: CreditHolderType.User,
    ownerId: 'u1',
    requestedBy: 'u1',
    source: 'api',
    state: 'running',
    payload: {
      request: {
        model: 'gemini-omni-1.1-flash',
        mode: 'text_to_video',
        prompt: 'a lighthouse',
        durationSeconds: 6,
        aspectRatio: '16:9',
        resolution: '720p',
      },
      providerId: 'gemini-omni',
    },
    progress: 0.4,
    pollCount: 1,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T00:20:00Z'),
    creditHold: {
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      userId: 'u1',
      organizationId: null,
      reservedCredits: 6085,
      balanceAfterHold: 100,
    },
    createdAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: new Date('2026-10-06T00:01:00Z'),
    ...overrides,
  }) as IGenerationJobDocument;

const succeeded = (location: 'files' | 'generated') =>
  job({
    state: 'succeeded',
    settledCredits: 6085,
    payload: {
      ...job().payload,
      output: {
        location,
        s3Key: 'generated-video/j.mp4',
        ...(location === 'files' && { fileId: 'f1' }),
        contentType: 'video/mp4',
        bytes: 10,
        durationSeconds: 6,
      },
    },
  });

describe('toPublicVideoGeneration', () => {
  const now = () => new Date('2026-10-06T00:02:00Z');

  it('renders an in-flight job without output and validates against the published schema', async () => {
    const sign = vi.fn();
    const resource = await toPublicVideoGeneration(job(), { sign, now });
    expect(VideoGenerationSchema.parse(resource)).toEqual(resource);
    expect(resource).toMatchObject({
      object: 'video_generation',
      state: 'running',
      duration_seconds: 6,
      aspect_ratio: '16:9',
      progress: 0.4,
      output: null,
      error: null,
      credits: { reserved: 6085, settled: null },
      created_at: '2026-10-06T00:00:00.000Z',
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it('mints a fresh 900s URL on every read and reports expires_at', async () => {
    let n = 0;
    const sign = vi.fn(async () => ({ availability: 'ready' as const, url: `https://signed.example/${++n}` }));
    const first = await toPublicVideoGeneration(succeeded('files'), { sign, now });
    const second = await toPublicVideoGeneration(succeeded('files'), { sign, now });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'files', s3Key: 'generated-video/j.mp4', fileId: 'f1' }),
      OUTPUT_URL_TTL_SECONDS
    );
    expect(OUTPUT_URL_TTL_SECONDS).toBe(900);
    expect(first.output?.url).not.toBe(second.output?.url);
    expect(first.output).toMatchObject({
      availability: 'ready',
      expires_at: '2026-10-06T00:17:00.000Z',
      file_id: 'f1',
      content_type: 'video/mp4',
    });
  });

  it('signs generated-bucket output with a null file_id', async () => {
    const sign = vi.fn(async () => ({ availability: 'ready' as const, url: 'https://signed.example/g' }));
    const resource = await toPublicVideoGeneration(succeeded('generated'), { sign, now });
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ location: 'generated' }), 900);
    expect(resource.output).toMatchObject({ availability: 'ready', url: 'https://signed.example/g', file_id: null });
    expect(VideoGenerationSchema.parse(resource)).toEqual(resource);
  });

  it.each(['pending_scan', 'unavailable'] as const)(
    'reports %s with a null url and expires_at when the output is not serveable',
    async availability => {
      const sign = vi.fn(async () => ({ availability }));
      const resource = await toPublicVideoGeneration(succeeded('files'), { sign, now });
      expect(resource.output).toEqual({
        availability,
        url: null,
        expires_at: null,
        file_id: 'f1',
        content_type: 'video/mp4',
        duration_seconds: 6,
      });
      expect(VideoGenerationSchema.parse(resource)).toEqual(resource);
    }
  );

  it('never echoes the stored error message', async () => {
    const resource = await toPublicVideoGeneration(
      job({ state: 'failed', error: { code: 'provider_error', message: 'gemini_omni_http_500 raw upstream text' } }),
      { sign: vi.fn(), now }
    );
    expect(resource.error).toEqual({ code: 'provider_error', message: 'The provider failed to generate the video.' });
  });

  it('folds an internal-only code into a public one with the fixed message', async () => {
    const resource = await toPublicVideoGeneration(
      job({ state: 'failed', error: { code: 'orphaned_submit', message: 'raw upstream text' } }),
      { sign: vi.fn(), now }
    );
    expect(resource.error).toEqual({ code: 'provider_error', message: 'The provider failed to generate the video.' });
    expect(JSON.stringify(resource)).not.toContain('raw upstream text');
    expect(VideoGenerationSchema.parse(resource)).toEqual(resource);
  });
});
