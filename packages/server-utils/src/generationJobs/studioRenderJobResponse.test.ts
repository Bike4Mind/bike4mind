import { describe, expect, it } from 'vitest';
import {
  CreditHolderType,
  GENERATION_JOB_ERROR_CODES,
  StudioRenderJobSchema,
  type IGenerationJobDocumentOf,
} from '@bike4mind/common';
import { renderJobRefusalBody, toStudioRenderJob } from './studioRenderJobResponse';

type RenderJob = IGenerationJobDocumentOf<'render'>;

const OUTPUT = { id: 'out-wide', aspectRatio: '16:9', width: 1920, height: 1080 } as const;

const makeJob = (overrides: Partial<RenderJob> = {}): RenderJob => ({
  id: 'a'.repeat(24),
  kind: 'render',
  ownerType: CreditHolderType.User,
  ownerId: 'u1',
  requestedBy: 'u1',
  source: 'studio',
  state: 'running',
  progress: 0.5,
  pollCount: 0,
  attempts: 0,
  cancelRequested: false,
  deadlineAt: new Date('2026-11-17T01:00:00Z'),
  creditHold: {
    ownerId: 'u1',
    ownerType: CreditHolderType.User,
    userId: 'u1',
    organizationId: null,
    reservedCredits: 20,
    balanceAfterHold: 100,
  },
  settledCredits: 18,
  createdAt: new Date('2026-11-17T00:00:00Z'),
  updatedAt: new Date('2026-11-17T00:00:00Z'),
  payload: {
    request: {
      compositionId: 'b'.repeat(24),
      title: 'Spring ad',
      output: OUTPUT,
      timeline: {
        version: 1,
        durationMs: 1000,
        fps: 30,
        backgroundColor: '#000000',
        outputs: [OUTPUT],
        tracks: [],
      },
    },
    pricing: { usdPerOutputSecond: 0.01, billedSeconds: 1, usd: 0.01 },
    groupId: 'c'.repeat(24),
    groupSize: 2,
  },
  ...overrides,
});

describe('toStudioRenderJob', () => {
  it('maps the job fields and leaves the timeline, hold and lease server-side', () => {
    const response = toStudioRenderJob(makeJob());
    expect(response).toEqual({
      id: 'a'.repeat(24),
      groupId: 'c'.repeat(24),
      compositionId: 'b'.repeat(24),
      state: 'running',
      progress: 0.5,
      output: OUTPUT,
      heldCredits: 20,
      settledCredits: 18,
      error: null,
      file: null,
      createdAt: '2026-11-17T00:00:00.000Z',
    });
    expect(StudioRenderJobSchema.safeParse(response).success).toBe(true);
  });

  it('uses null for what a job has not got yet', () => {
    const response = toStudioRenderJob(makeJob({ progress: undefined, creditHold: null, settledCredits: undefined }));
    expect(response).toMatchObject({ progress: null, heldCredits: null, settledCredits: null });
    expect(StudioRenderJobSchema.safeParse(response).success).toBe(true);
  });

  it('maps the stored output to the file', () => {
    const job = makeJob({ state: 'succeeded' });
    job.payload.output = {
      location: 'files',
      s3Key: 'files/x.mp4',
      fileId: 'd'.repeat(24),
      contentType: 'video/mp4',
      bytes: 1234,
      durationSeconds: 9.5,
    };
    const response = toStudioRenderJob(job);
    expect(response.file).toEqual({ fileId: 'd'.repeat(24), bytes: 1234, durationSeconds: 9.5 });
    expect(StudioRenderJobSchema.safeParse(response).success).toBe(true);
  });

  it('reports a null fileId for an output kept in the generated bucket', () => {
    const job = makeJob({ state: 'succeeded' });
    job.payload.output = {
      location: 'generated',
      s3Key: 'studio-render/u1/x.mp4',
      contentType: 'video/mp4',
      bytes: 10,
      durationSeconds: 1,
    };
    expect(toStudioRenderJob(job).file).toEqual({ fileId: null, bytes: 10, durationSeconds: 1 });
  });

  it('never leaks the stored error message, only fixed copy for the code', () => {
    const raw = 'ffmpeg: Conversion failed at /tmp/render/secret-path';
    const response = toStudioRenderJob(makeJob({ state: 'failed', error: { code: 'provider_error', message: raw } }));
    expect(response.error).toEqual({
      code: 'provider_error',
      message: 'The export failed. Your credits were refunded.',
    });
    expect(JSON.stringify(response)).not.toContain(raw);
    expect(StudioRenderJobSchema.safeParse(response).success).toBe(true);
  });

  it.each(GENERATION_JOB_ERROR_CODES)('has non-empty fixed copy for the %s code', code => {
    const response = toStudioRenderJob(makeJob({ state: 'failed', error: { code, message: 'raw worker text' } }));
    expect(response.error?.code).toBe(code);
    expect(response.error?.message).toBeTruthy();
    expect(response.error?.message).not.toBe('raw worker text');
  });
});

describe('renderJobRefusalBody', () => {
  it('carries the code and message', () => {
    expect(
      renderJobRefusalBody({
        ok: false,
        status: 422,
        code: 'empty_timeline',
        message: 'The timeline has nothing to render',
      })
    ).toEqual({ error: 'empty_timeline', message: 'The timeline has nothing to render' });
  });

  it('adds the storage details when present', () => {
    const storage = {
      errorCode: 'storage_limit_exceeded',
      used_bytes: 1,
      limit_bytes: 2,
      requested_bytes: 3,
      owner: 'user',
    } as const;
    expect(
      renderJobRefusalBody({
        ok: false,
        status: 400,
        code: 'storage_quota_exceeded',
        message: 'Storage quota exceeded',
        storage,
      })
    ).toMatchObject({ error: 'storage_quota_exceeded', storage });
  });
});
