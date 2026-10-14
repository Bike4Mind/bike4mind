import { describe, expect, it, vi } from 'vitest';
import {
  CreditHolderType,
  MUSIC_JOB_PUBLIC_ERROR_CODES,
  MusicGenerationSchema,
  type IGenerationJobDocumentOf,
} from '@bike4mind/common';
import { OUTPUT_URL_TTL_SECONDS } from '@server/generations/signedOutput';
import { toPublicMusicGeneration } from './toPublicMusicGeneration';

const job = (overrides: Partial<IGenerationJobDocumentOf<'music'>> = {}): IGenerationJobDocumentOf<'music'> =>
  ({
    id: '664f1c2b9a1e4d0012ab34cd',
    kind: 'music',
    ownerType: CreditHolderType.User,
    ownerId: 'u1',
    requestedBy: 'u1',
    source: 'api',
    state: 'running',
    payload: {
      request: {
        model: 'test-music',
        prompt: 'a calm piano piece',
        lyrics: 'la la la',
        instrumental: false,
        durationSeconds: 5,
      },
      providerId: 'test',
    },
    pollCount: 1,
    attempts: 0,
    cancelRequested: false,
    deadlineAt: new Date('2026-10-06T00:20:00Z'),
    creditHold: {
      ownerId: 'u1',
      ownerType: CreditHolderType.User,
      userId: 'u1',
      organizationId: null,
      reservedCredits: 80,
      balanceAfterHold: 100,
    },
    createdAt: new Date('2026-10-06T00:00:00Z'),
    updatedAt: new Date('2026-10-06T00:01:00Z'),
    ...overrides,
  }) as IGenerationJobDocumentOf<'music'>;

const succeeded = (location: 'files' | 'generated', lyrics?: string) =>
  job({
    state: 'succeeded',
    settledCredits: 80,
    payload: {
      ...job().payload,
      output: {
        location,
        s3Key: 'generated-music/j.mp3',
        ...(location === 'files' && { fileId: 'f1' }),
        contentType: 'audio/mpeg',
        bytes: 10,
        durationSeconds: 5,
        ...(lyrics !== undefined && { lyrics }),
      },
    },
  });

describe('toPublicMusicGeneration', () => {
  const now = () => new Date('2026-10-06T00:02:00Z');

  it('renders an in-flight job without output and validates against the published schema', async () => {
    const sign = vi.fn();
    const resource = await toPublicMusicGeneration(job(), { sign, now });
    expect(MusicGenerationSchema.parse(resource)).toEqual(resource);
    expect(resource).toMatchObject({
      object: 'music_generation',
      state: 'running',
      model: 'test-music',
      lyrics: 'la la la',
      instrumental: false,
      duration_seconds: 5,
      output: null,
      error: null,
      credits: { reserved: 80, settled: null },
      created_at: '2026-10-06T00:00:00.000Z',
      updated_at: '2026-10-06T00:01:00.000Z',
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it('renders absent lyrics as null', async () => {
    const { lyrics: _lyrics, ...request } = job().payload.request;
    const resource = await toPublicMusicGeneration(job({ payload: { ...job().payload, request } }), {
      sign: vi.fn(),
      now,
    });
    expect(resource.lyrics).toBeNull();
  });

  it('mints a fresh 900s URL on every read and reports expires_at', async () => {
    let n = 0;
    const sign = vi.fn(async () => ({ availability: 'ready' as const, url: `https://signed.example/${++n}` }));
    const first = await toPublicMusicGeneration(succeeded('files', 'sung lines'), { sign, now });
    const second = await toPublicMusicGeneration(succeeded('files', 'sung lines'), { sign, now });
    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'files', s3Key: 'generated-music/j.mp3', fileId: 'f1' }),
      OUTPUT_URL_TTL_SECONDS
    );
    expect(OUTPUT_URL_TTL_SECONDS).toBe(900);
    expect(first.credits).toEqual({ reserved: 80, settled: 80 });
    expect(first.output?.url).not.toBe(second.output?.url);
    expect(first.output).toMatchObject({
      availability: 'ready',
      expires_at: '2026-10-06T00:17:00.000Z',
      file_id: 'f1',
      content_type: 'audio/mpeg',
      lyrics: 'sung lines',
    });
    expect(MusicGenerationSchema.parse(first)).toEqual(first);
  });

  it('signs generated-bucket output with a null file_id and null lyrics when none were sung', async () => {
    const sign = vi.fn(async () => ({ availability: 'ready' as const, url: 'https://signed.example/g' }));
    const resource = await toPublicMusicGeneration(succeeded('generated'), { sign, now });
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ location: 'generated' }), 900);
    expect(resource.output).toMatchObject({
      availability: 'ready',
      url: 'https://signed.example/g',
      file_id: null,
      lyrics: null,
    });
    expect(MusicGenerationSchema.parse(resource)).toEqual(resource);
  });

  it.each(['pending_scan', 'unavailable'] as const)(
    'reports %s with a null url and expires_at when the output is not serveable',
    async availability => {
      const sign = vi.fn(async () => ({ availability }));
      const resource = await toPublicMusicGeneration(succeeded('files'), { sign, now });
      expect(resource.output).toEqual({
        availability,
        url: null,
        expires_at: null,
        file_id: 'f1',
        content_type: 'audio/mpeg',
        duration_seconds: 5,
        lyrics: null,
      });
      expect(MusicGenerationSchema.parse(resource)).toEqual(resource);
    }
  );

  it('does not sign the output of a job that is not succeeded', async () => {
    const sign = vi.fn();
    const resource = await toPublicMusicGeneration(
      job({ state: 'storing', payload: { ...succeeded('files').payload } }),
      { sign, now }
    );
    expect(resource.output).toBeNull();
    expect(sign).not.toHaveBeenCalled();
  });

  it('never echoes the stored error message', async () => {
    const resource = await toPublicMusicGeneration(
      job({ state: 'failed', error: { code: 'provider_error', message: 'lyria_http_500 raw upstream text' } }),
      { sign: vi.fn(), now }
    );
    expect(resource.error).toEqual({ code: 'provider_error', message: 'The provider failed to generate the song.' });
    expect(JSON.stringify(resource)).not.toContain('raw upstream text');
  });

  it.each(MUSIC_JOB_PUBLIC_ERROR_CODES)('passes the public code %s through with a fixed message', async code => {
    const resource = await toPublicMusicGeneration(
      job({ state: 'failed', error: { code, message: 'raw upstream text' } }),
      { sign: vi.fn(), now }
    );
    expect(resource.error).toEqual({ code, message: expect.any(String) });
    expect(JSON.stringify(resource)).not.toContain('raw upstream text');
    expect(MusicGenerationSchema.parse(resource)).toEqual(resource);
  });

  it.each(['orphaned_submit', 'enqueue_failed', 'input_image_not_found'] as const)(
    'folds the internal-only code %s into provider_error with the fixed message',
    async code => {
      const resource = await toPublicMusicGeneration(
        job({ state: 'failed', error: { code, message: 'raw upstream text' } }),
        { sign: vi.fn(), now }
      );
      expect(resource.error).toEqual({ code: 'provider_error', message: 'The provider failed to generate the song.' });
      expect(JSON.stringify(resource)).not.toContain('raw upstream text');
      expect(MusicGenerationSchema.parse(resource)).toEqual(resource);
    }
  );
});
