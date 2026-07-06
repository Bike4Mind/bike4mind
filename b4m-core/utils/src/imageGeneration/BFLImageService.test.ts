import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { BFLImageService } from './BFLImageService';
import { ImageModels, BFL_SAFETY_TOLERANCE } from '@bike4mind/common';

const API_KEY = 'TEST-BFL-KEY-0a1b2c3d-do-not-log';

/**
 * Regression: the Kontext `transform()` path has a nested try/catch around the
 * keyed POST. When that POST fails, the AxiosError carries the `x-key` request
 * header, and logging it raw leaked the API key to CloudWatch.
 */
describe('BFLImageService — does not leak the API key to logs (#9230)', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    const capture = (...args: unknown[]) =>
      logged.push(
        args
          .map(a => {
            try {
              return typeof a === 'string' ? a : JSON.stringify(a);
            } catch {
              return String(a);
            }
          })
          .join(' ')
      );
    vi.spyOn(console, 'error').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('never writes the x-key into any console output when the transform POST fails', async () => {
    // The AxiosError axios attaches when the keyed POST fails - config.headers
    // carries the x-key, exactly as in the production alert.
    const axiosError = Object.assign(new Error('Request failed with status code 402'), {
      isAxiosError: true,
      config: {
        url: 'https://api.bfl.ai/v1/flux-kontext-pro',
        method: 'post',
        headers: { 'x-key': API_KEY, 'Content-Type': 'application/json' },
      },
      response: { status: 402, data: { detail: 'Insufficient credits' }, headers: {} },
    });
    vi.spyOn(axios, 'post').mockRejectedValue(axiosError);

    const svc = new BFLImageService(API_KEY, { log() {}, error() {}, warn() {}, info() {} } as never);

    await expect(
      svc.transform('base64imagedata', 'make it pop', { model: ImageModels.FLUX_KONTEXT_PRO })
    ).rejects.toBeTruthy();

    // The failure must have been logged (otherwise the assertion is vacuous)...
    expect(logged.length).toBeGreaterThan(0);
    // ...but the API key must never appear in any logged argument.
    expect(logged.join('\n')).not.toContain(API_KEY);
  });
});

describe('BFLImageService — safety_tolerance hard cap', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;
  let service: BFLImageService;

  function submittedBody(callIndex = 0): Record<string, unknown> {
    return postSpy.mock.calls[callIndex][1] as Record<string, unknown>;
  }

  beforeEach(() => {
    postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { id: 'req-1', polling_url: 'https://api.bfl.ai/v1/poll/req-1' },
    });
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'Ready', result: { sample: 'https://img.example/out.png' } },
    });
    service = new BFLImageService(API_KEY, { log() {}, error() {}, warn() {}, info() {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('generate() caps safety_tolerance at the hard cap before submitting to the BFL API', async () => {
    await service.generate('a friendly cat', { safety_tolerance: 6 });

    expect(submittedBody().safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.MAX);
  });

  it('generate() uses the shared default when safety_tolerance is omitted', async () => {
    await service.generate('a friendly cat', {});

    expect(submittedBody().safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.DEFAULT);
  });

  it('generate() clamps negative safety_tolerance up to MIN', async () => {
    await service.generate('a friendly cat', { safety_tolerance: -3 });

    expect(submittedBody().safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.MIN);
  });

  it('edit() caps safety_tolerance at the hard cap before submitting to the BFL API', async () => {
    await service.edit('base64-image', 'remove the hat', { mask: null, safety_tolerance: 6 });

    expect(submittedBody().safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.MAX);
  });

  it('transform() caps safety_tolerance at the hard cap before submitting to the BFL API', async () => {
    await service.transform('base64-image', 'make it a watercolor', { safety_tolerance: 6 });

    expect(submittedBody().safety_tolerance).toBe(BFL_SAFETY_TOLERANCE.MAX);
  });
});
