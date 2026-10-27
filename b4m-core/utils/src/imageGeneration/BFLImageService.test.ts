import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { BFLImageService } from './BFLImageService';
import { ImageModels, BFL_SAFETY_TOLERANCE } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { ImageModerationBlockedError, ImageProviderUnavailableError } from './imageGenerationErrors';

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

describe('BFLImageService - reference image field', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  let service: BFLImageService;

  const submittedBody = (callIndex = 0): Record<string, unknown> =>
    postSpy.mock.calls[callIndex][1] as Record<string, unknown>;

  beforeEach(() => {
    logged = [];
    const capture = (...args: unknown[]) =>
      logged.push(
        args
          .map(arg => {
            try {
              return typeof arg === 'string' ? arg : JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(' ')
      );
    postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      data: { id: 'req-1', polling_url: 'https://api.bfl.ai/v1/poll/req-1' },
    });
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { status: 'Ready', result: { sample: 'https://img.example/out.png' } },
    });
    vi.spyOn(console, 'info').mockImplementation(capture);
    vi.spyOn(console, 'log').mockImplementation(capture);
    service = new BFLImageService(API_KEY, { log() {}, error() {}, warn() {}, info() {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a FLUX.2 reference image as input_image, the field those endpoints define', async () => {
    await service.generate('make it pop', { model: ImageModels.FLUX_2_PRO, image_prompt: 'base64-image' });

    expect(submittedBody().input_image).toBe('base64-image');
    expect(submittedBody()).not.toHaveProperty('image_prompt');
  });

  it('still sends a FLUX.1 reference image as image_prompt', async () => {
    await service.generate('make it pop', { model: ImageModels.FLUX_PRO_1_1, image_prompt: 'base64-image' });

    expect(submittedBody().image_prompt).toBe('base64-image');
    expect(submittedBody()).not.toHaveProperty('input_image');
  });

  it('sends FLUX.2 references in order using numbered provider fields', async () => {
    await service.generate('combine these', {
      model: ImageModels.FLUX_2_PRO,
      reference_images: ['first-image', 'second-image', 'third-image'],
    });

    expect(submittedBody()).toMatchObject({
      input_image: 'first-image',
      input_image_2: 'second-image',
      input_image_3: 'third-image',
    });
    expect(submittedBody()).not.toHaveProperty('reference_images');
    expect(submittedBody()).not.toHaveProperty('image_prompt');
    const output = logged.join('\n');
    for (const image of ['first-image', 'second-image', 'third-image']) {
      expect(output).not.toContain(image);
    }
  });

  it.each([
    [ImageModels.FLUX_2_PRO, 8],
    [ImageModels.FLUX_2_KLEIN_4B, 4],
    [ImageModels.FLUX_2_KLEIN_9B, 4],
    [ImageModels.FLUX_2_KLEIN_9B_PREVIEW, 4],
  ] as const)('enforces the reference limit for %s before submitting', async (model, limit) => {
    const reference_images = Array.from({ length: limit }, (_, index) => `image-${index}`);
    await service.generate('combine these', { model, reference_images });
    expect(submittedBody()[`input_image_${limit}`]).toBe(`image-${limit - 1}`);
    postSpy.mockClear();

    await expect(
      service.generate('too many', { model, reference_images: [...reference_images, 'one-too-many'] })
    ).rejects.toThrow(`at most ${limit} reference images`);
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('counts a legacy primary image toward the FLUX.2 limit', async () => {
    await expect(
      service.generate('too many', {
        model: ImageModels.FLUX_2_KLEIN_4B,
        image_prompt: 'primary',
        reference_images: ['reference-1', 'reference-2', 'reference-3', 'reference-4'],
      })
    ).rejects.toThrow('at most 4 reference images');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('rejects explicit references for FLUX.1 instead of silently discarding them', async () => {
    await expect(
      service.generate('combine these', { model: ImageModels.FLUX_PRO_1_1, reference_images: ['image'] })
    ).rejects.toThrow('does not support multiple reference images');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('redacts the FLUX.2 reference image in the logged body', async () => {
    await service.generate('make it pop', { model: ImageModels.FLUX_2_PRO, image_prompt: 'base64-secret-image' });

    const output = logged.join('\n');
    expect(output).toContain('BFL Image generation request body');
    expect(output).toContain('[BASE64_DATA_19_CHARS]');
    expect(output).not.toContain('base64-secret-image');
  });
});

describe('BFLImageService - request body', () => {
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

  it('generate() forwards prompt_upsampling: true to the BFL API', async () => {
    await service.generate('a friendly cat', { prompt_upsampling: true });

    expect(submittedBody().prompt_upsampling).toBe(true);
  });

  it('generate() forwards prompt_upsampling: false to the BFL API', async () => {
    await service.generate('a friendly cat', { prompt_upsampling: false });

    expect(submittedBody().prompt_upsampling).toBe(false);
  });

  it('generate() defaults prompt_upsampling to false when it is omitted', async () => {
    await service.generate('a friendly cat', {});

    expect(submittedBody().prompt_upsampling).toBe(false);
  });

  it.each([ImageModels.FLUX_2_MAX, ImageModels.FLUX_2_PRO, ImageModels.FLUX_2_PRO_PREVIEW])(
    'maps prompt upsampling to disable_pup for %s',
    async model => {
      await service.generate('a friendly cat', { model, prompt_upsampling: true });
      expect(submittedBody().disable_pup).toBe(false);
      expect(submittedBody()).not.toHaveProperty('prompt_upsampling');

      await service.generate('a friendly cat', { model, prompt_upsampling: false });
      expect(submittedBody(1).disable_pup).toBe(true);
    }
  );

  it('keeps the prompt_upsampling field for FLUX.2 Flex', async () => {
    await service.generate('a friendly cat', { model: ImageModels.FLUX_2_FLEX, prompt_upsampling: true });
    expect(submittedBody().prompt_upsampling).toBe(true);
    expect(submittedBody()).not.toHaveProperty('disable_pup');
  });

  it.each([ImageModels.FLUX_2_KLEIN_4B, ImageModels.FLUX_2_KLEIN_9B, ImageModels.FLUX_2_KLEIN_9B_PREVIEW])(
    'omits unsupported prompt upsampling for %s',
    async model => {
      await service.generate('a friendly cat', { model, prompt_upsampling: true });
      expect(submittedBody()).not.toHaveProperty('prompt_upsampling');
      expect(submittedBody()).not.toHaveProperty('disable_pup');
    }
  );
});

describe('BFLImageService - expected failures stay below error level', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let service: BFLImageService;

  const POLLING_URL = 'https://api.bfl.ai/v1/poll/req-1';

  function pollReturns(data: Record<string, unknown>) {
    vi.spyOn(axios, 'get').mockResolvedValue({ data });
  }

  beforeEach(() => {
    vi.spyOn(axios, 'post').mockResolvedValue({ data: { id: 'req-1', polling_url: POLLING_URL } });
    errorSpy = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.globalInstance, 'debug').mockImplementation(() => undefined);
    vi.spyOn(Logger.globalInstance, 'log').mockImplementation(() => undefined);
    service = new BFLImageService(API_KEY, { log() {}, error() {}, warn() {}, info() {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['Request Moderated', 'Content Moderated'])(
    'throws ImageModerationBlockedError for a %s poll status',
    async status => {
      pollReturns({ status });

      const thrown = await service.generate('a prompt', { model: ImageModels.FLUX_PRO }).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(ImageModerationBlockedError);
      expect((thrown as ImageModerationBlockedError).logContext).toMatchObject({
        provider: 'bfl',
        requestId: 'req-1',
        reason: status,
      });
      expect(errorSpy).not.toHaveBeenCalled();
    }
  );

  it('throws ImageProviderUnavailableError when polling runs out of attempts', async () => {
    pollReturns({ status: 'Pending' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thrown = await (service as any).pollForResult('req-1', POLLING_URL, 1, 0).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ImageProviderUnavailableError);
    expect((thrown as ImageProviderUnavailableError).logContext).toMatchObject({
      provider: 'bfl',
      reason: 'polling_timeout',
      requestId: 'req-1',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it.each(['ETIMEDOUT', 'ENETUNREACH'])('treats a %s network failure as provider unavailable', async code => {
    vi.spyOn(axios, 'post').mockRejectedValue(
      Object.assign(new Error(`connect ${code}`), { isAxiosError: true, code, config: { headers: {} } })
    );

    const thrown = await service.generate('a prompt', { model: ImageModels.FLUX_PRO }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ImageProviderUnavailableError);
    expect((thrown as ImageProviderUnavailableError).logContext).toMatchObject({ provider: 'bfl', reason: code });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('treats polling that ends on a non-Pending status as a genuine failure', async () => {
    pollReturns({ status: 'Task not found' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thrown = await (service as any).pollForResult('req-1', POLLING_URL, 1, 0).catch((e: unknown) => e);

    expect(thrown).not.toBeInstanceOf(ImageProviderUnavailableError);
    expect((thrown as Error).message).toBe('BFL polling ended on unexpected status: Task not found');
  });

  it('logs a genuine task failure once, at error', async () => {
    pollReturns({ status: 'Error', result: { error: 'internal' } });

    await expect(service.generate('a prompt', { model: ImageModels.FLUX_PRO })).rejects.toThrow(
      'BFL image generation failed: internal'
    );
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("logs a 422's provider detail, but not the echoed input", async () => {
    vi.spyOn(axios, 'post').mockRejectedValue(
      Object.assign(new Error('Request failed with status code 422'), {
        isAxiosError: true,
        code: 'ERR_BAD_REQUEST',
        config: { method: 'post', headers: { 'x-key': API_KEY } },
        response: {
          status: 422,
          data: {
            detail: [{ loc: ['body', 'width'], msg: 'Input should be a multiple of 32', input: 'SECRET PROMPT' }],
          },
        },
      })
    );

    await expect(service.generate('a prompt', { model: ImageModels.FLUX_PRO })).rejects.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls[0]);
    expect(logged).toContain('body.width: Input should be a multiple of 32');
    expect(logged).not.toContain('SECRET PROMPT');
    expect(logged).not.toContain(API_KEY);
  });
});
