import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STUDIO_RENDER_PRICING,
  STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT,
  StudioRenderCreateInputSchema,
  StudioRenderPricingSchema,
  StudioRenderQueueMessageSchema,
  StudioRenderStatusSchema,
  estimateStudioRenderUsd,
  studioRenderBilledSeconds,
  studioRenderOutputKey,
  studioRenderStatusKey,
} from './render';

const JOB_ID = 'a'.repeat(24);
const updatedAt = '2026-11-17T00:00:00Z';

describe('studioRenderBilledSeconds', () => {
  it.each([
    [1, 1],
    [1000, 1],
    [1001, 2],
    [15_200, 16],
    [15_000, 15],
  ])('bills a %dms timeline as %d seconds, rounding up', (durationMs, seconds) => {
    expect(studioRenderBilledSeconds({ durationMs })).toBe(seconds);
  });
});

describe('estimateStudioRenderUsd', () => {
  const pricing = { usdPerOutputSecond: { '16:9': 0.01, '9:16': 0.02, '1:1': 0.03, '4:5': 0.04 } };

  it('multiplies the billed seconds by the ratio rate', () => {
    expect(estimateStudioRenderUsd({ durationMs: 15_200 }, '9:16', pricing)).toBeCloseTo(16 * 0.02);
    expect(estimateStudioRenderUsd({ durationMs: 15_200 }, '4:5', pricing)).toBeCloseTo(16 * 0.04);
  });

  it('prices a free ratio at zero', () => {
    const free = { usdPerOutputSecond: { ...pricing.usdPerOutputSecond, '1:1': 0 } };
    expect(estimateStudioRenderUsd({ durationMs: 5000 }, '1:1', free)).toBe(0);
  });

  it('is accepted by the pricing schema in its default form', () => {
    expect(StudioRenderPricingSchema.safeParse(DEFAULT_STUDIO_RENDER_PRICING).success).toBe(true);
    expect(StudioRenderPricingSchema.safeParse({ usdPerOutputSecond: { '16:9': -1 } }).success).toBe(false);
  });
});

describe('StudioRenderStatusSchema', () => {
  it.each([
    [{ state: 'running', progress: 0.5, updatedAt }],
    [{ state: 'succeeded', s3Key: 'studio-render/x/output.mp4', bytes: 10, durationSeconds: 1.5, updatedAt }],
    [{ state: 'failed', message: 'ffmpeg exited 1', updatedAt }],
  ])('accepts %j', status => {
    expect(StudioRenderStatusSchema.safeParse(status).success).toBe(true);
  });

  it.each([
    ['an unknown state', { state: 'queued', updatedAt }],
    ['running progress above 1', { state: 'running', progress: 1.5, updatedAt }],
    ['a succeeded report without its output', { state: 'succeeded', updatedAt }],
    ['a succeeded report with zero bytes', { state: 'succeeded', s3Key: 'k', bytes: 0, durationSeconds: 1, updatedAt }],
    ['a failed report over the message cap', { state: 'failed', message: 'x'.repeat(501), updatedAt }],
  ])('rejects %s', (_label, status) => {
    expect(StudioRenderStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe('StudioRenderCreateInputSchema', () => {
  it('accepts between 1 and the export cap of output ids', () => {
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: ['a'] }).success).toBe(true);
    const cap = Array.from({ length: STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT }, (_, index) => `o${index}`);
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: cap }).success).toBe(true);
  });

  it('rejects no ids and one id past the cap', () => {
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: [] }).success).toBe(false);
    const past = Array.from({ length: STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT + 1 }, (_, index) => `o${index}`);
    expect(STUDIO_RENDER_MAX_OUTPUTS_PER_EXPORT).toBe(8);
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: past }).success).toBe(false);
  });

  it('rejects empty and over-long ids and extra keys', () => {
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: [''] }).success).toBe(false);
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: ['x'.repeat(65)] }).success).toBe(false);
    expect(StudioRenderCreateInputSchema.safeParse({ outputIds: ['a'], userId: 'someone' }).success).toBe(false);
  });
});

describe('queue message and object keys', () => {
  it('accepts only a lowercase 24-hex job id', () => {
    expect(StudioRenderQueueMessageSchema.safeParse({ jobId: JOB_ID }).success).toBe(true);
    expect(StudioRenderQueueMessageSchema.safeParse({ jobId: 'A'.repeat(24) }).success).toBe(false);
    expect(StudioRenderQueueMessageSchema.safeParse({ jobId: 'abc' }).success).toBe(false);
  });

  it('keys the status and output objects under the job id', () => {
    expect(studioRenderStatusKey(JOB_ID)).toBe(`studio-render/${JOB_ID}/status.json`);
    expect(studioRenderOutputKey(JOB_ID)).toBe(`studio-render/${JOB_ID}/output.mp4`);
  });
});
