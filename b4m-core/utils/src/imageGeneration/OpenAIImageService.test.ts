import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';
import { ImageModels } from '@bike4mind/common';

// The service builds its OpenAI client inside each call, so there is no instance to
// stub - the SDK module is mocked instead. The spies are only dereferenced when a
// method is invoked, which is well after this module has finished initialising.
const imagesEdit = vi.fn();
const imagesGenerate = vi.fn();
vi.mock('openai', () => {
  class MockAPIError extends Error {}
  class MockOpenAI {
    images = {
      edit: (...args: unknown[]) => imagesEdit(...args),
      generate: (...args: unknown[]) => imagesGenerate(...args),
    };
    static APIError = MockAPIError;
  }
  return { default: MockOpenAI };
});

// invokeImageProcessor normally round-trips through a Lambda; these tests only care
// what reaches images.edit, so the buffer passes straight through.
vi.mock('./imageProcessorUtils', () => ({
  invokeImageProcessor: vi.fn(async (buffer: Buffer) => buffer),
  downloadImageAsBuffer: vi.fn(),
}));

import {
  buildModerationBlockedError,
  isSupportedEditSize,
  OpenAIImageService,
  resolveGptImageOutputOptions,
} from './OpenAIImageService';
import { downloadImageAsBuffer } from './imageProcessorUtils';

// The helper only reads `code`, `status`, and `requestID` off the error, so a
// minimal object cast to the APIError instance type is sufficient and avoids
// fragile coupling to the SDK's constructor signature.
type APIErrorLike = InstanceType<typeof OpenAI.APIError>;
function makeApiError(props: Partial<{ status: number; code: string | null; requestID: string }>): APIErrorLike {
  return props as unknown as APIErrorLike;
}

describe('buildModerationBlockedError', () => {
  it('returns a friendly error for an explicit moderation_blocked code (#9251)', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it("returns a friendly error for DALL-E 3's content_policy_violation code", () => {
    // DALL-E 3 (generation-only) rejects policy violations with a non-empty code
    // that is not `moderation_blocked` - it must still get the friendly message.
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'content_policy_violation' }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it('guides the user toward alternative models with different content policies', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result?.message).toContain('Flux Pro');
    expect(result?.message).toMatch(/alternative model/i);
  });

  it('includes the OpenAI request ID when present so users can report false positives', () => {
    const result = buildModerationBlockedError(
      makeApiError({ status: 400, code: 'moderation_blocked', requestID: 'req_abc123' })
    );

    expect(result?.message).toContain('req_abc123');
  });

  it('falls back to "unknown" request ID when none is provided', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'moderation_blocked' }));

    expect(result?.message).toContain('request ID: unknown');
  });

  it('treats a bare 400 with no code as a likely moderation block', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400 }));

    expect(result).toBeInstanceOf(Error);
    expect(result?.message).toContain("blocked by OpenAI's content policy");
  });

  it('does NOT mislabel a 400 carrying a specific parameter error code as moderation', () => {
    const result = buildModerationBlockedError(makeApiError({ status: 400, code: 'invalid_size' }));

    expect(result).toBeNull();
  });

  it('returns null for non-400 errors (e.g. rate limits, server errors)', () => {
    expect(buildModerationBlockedError(makeApiError({ status: 429, code: 'rate_limit_exceeded' }))).toBeNull();
    expect(buildModerationBlockedError(makeApiError({ status: 500 }))).toBeNull();
  });
});

describe('resolveGptImageOutputOptions', () => {
  it('forwards a transparent background so gpt-image returns a real alpha channel', () => {
    const warnings: string[] = [];

    expect(resolveGptImageOutputOptions('transparent', 'png', warnings)).toEqual({
      background: 'transparent',
      output_format: 'png',
    });
    expect(warnings).toEqual([]);
  });

  it('promotes jpeg to png for a transparent request, which OpenAI would otherwise reject', () => {
    const warnings: string[] = [];

    expect(resolveGptImageOutputOptions('transparent', 'jpeg', warnings)).toEqual({
      background: 'transparent',
      output_format: 'png',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('png');
  });

  it('leaves webp alone - it carries alpha', () => {
    const warnings: string[] = [];

    expect(resolveGptImageOutputOptions('transparent', 'webp', warnings)).toEqual({
      background: 'transparent',
      output_format: 'webp',
    });
    expect(warnings).toEqual([]);
  });

  it('keeps jpeg when the background is not transparent', () => {
    expect(resolveGptImageOutputOptions('opaque', 'jpeg', [])).toEqual({
      background: 'opaque',
      output_format: 'jpeg',
    });
  });

  it('omits unset fields so OpenAI applies its own defaults', () => {
    expect(resolveGptImageOutputOptions(undefined, undefined, [])).toEqual({});
    expect(resolveGptImageOutputOptions(null, null, [])).toEqual({});
  });

  it('drops a transparent background for gpt-image-2, which rejects it outright', () => {
    const warnings: string[] = [];

    expect(resolveGptImageOutputOptions('transparent', 'png', warnings, 'gpt-image-2')).toEqual({
      output_format: 'png',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('gpt-image-2');
  });

  it('keeps a transparent background for gpt-image-1.5, which supports it', () => {
    const warnings: string[] = [];

    expect(resolveGptImageOutputOptions('transparent', 'png', warnings, 'gpt-image-1.5')).toEqual({
      background: 'transparent',
      output_format: 'png',
    });
    expect(warnings).toEqual([]);
  });
});

describe('OpenAIImageService.generate output controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    imagesGenerate.mockResolvedValue({ created: 0, output_format: 'png', data: [{ b64_json: 'QUJD' }] });
  });

  const service = () => new OpenAIImageService('test-key', new Logger());

  it('sends background and output_format to gpt-image so a cutout PNG is possible', async () => {
    // gpt-image-2 rejects background: 'transparent', so this must use gpt-image-1.
    await service().generate('an inventory icon', {
      model: ImageModels.GPT_IMAGE_1,
      background: 'transparent',
      output_format: 'png',
    });

    expect(imagesGenerate).toHaveBeenCalledTimes(1);
    expect(imagesGenerate.mock.calls[0][0]).toMatchObject({ background: 'transparent', output_format: 'png' });
  });

  it('drops a transparent background for an explicitly-selected gpt-image-2, which would 400', async () => {
    await service().generate('an inventory icon', {
      model: ImageModels.GPT_IMAGE_2,
      background: 'transparent',
      output_format: 'png',
    });

    const sent = imagesGenerate.mock.calls[0][0];
    expect(sent.background).toBeUndefined();
    expect(sent.output_format).toBe('png');
  });

  it('drops both for a legacy (non gpt-image) model, which would reject them', async () => {
    imagesGenerate.mockResolvedValue({ created: 0, data: [{ url: 'https://example.test/i.png' }] });

    await service().generate('an inventory icon', {
      model: ImageModels.DALL_E_2,
      background: 'transparent',
      output_format: 'webp',
    });

    const sent = imagesGenerate.mock.calls[0][0];
    expect(sent.background).toBeUndefined();
    expect(sent.output_format).toBeUndefined();
  });

  it('labels the data URL with the format the response reports, not always png', async () => {
    imagesGenerate.mockResolvedValue({ created: 0, output_format: 'webp', data: [{ b64_json: 'QUJD' }] });

    const [image] = await service().generate('an inventory icon', {
      model: ImageModels.GPT_IMAGE_2,
      output_format: 'webp',
    });

    expect(image).toBe('data:image/webp;base64,QUJD');
  });
});

describe('isSupportedEditSize', () => {
  it('accepts the gpt-image-1 family presets', () => {
    for (const size of ['1024x1024', '1024x1536', '1536x1024']) {
      expect(isSupportedEditSize(ImageModels.GPT_IMAGE_1_5, size)).toBe(true);
    }
  });

  it('rejects a dall-e-2 size for the gpt-image-1 family', () => {
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_1_5, '512x512')).toBe(false);
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_1, '256x256')).toBe(false);
  });

  it('rejects a custom resolution for the gpt-image-1 family, which has fixed sizes', () => {
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_1_5, '1920x1088')).toBe(false);
  });

  it('accepts the gpt-image-2 presets and auto', () => {
    for (const size of ['1024x1024', '2048x2048', '2048x1152', '3840x2160', '2160x3840', 'auto']) {
      expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, size)).toBe(true);
    }
  });

  it('accepts a custom gpt-image-2 resolution that meets every constraint', () => {
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '1920x1088')).toBe(true);
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '1280x1024')).toBe(true);
  });

  it('rejects a custom gpt-image-2 resolution for each individual constraint', () => {
    // Each of these violates exactly one rule from IMAGE_SIZE_CONSTRAINTS.GPT_IMAGE_2.
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '1920x1080')).toBe(false); // 1080 is not a multiple of 16
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '800x800')).toBe(false); // under the minimum pixel count
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '3840x2224')).toBe(false); // over the maximum pixel count
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '3072x768')).toBe(false); // aspect ratio beyond 3:1
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, '3856x2144')).toBe(false); // long edge beyond 3840
  });

  it('rejects a size that is absent or not a WIDTHxHEIGHT pair', () => {
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, undefined)).toBe(false);
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, null)).toBe(false);
    expect(isSupportedEditSize(ImageModels.GPT_IMAGE_2, 'wide')).toBe(false);
  });
});

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`;

function makeService() {
  return new OpenAIImageService('test-key', new Logger(), 'image-processor-lambda');
}

type EditOptions = Parameters<OpenAIImageService['edit']>[2];

/** Runs edit() against the mocked SDK and returns the params it sent to images.edit. */
async function editParams(options: EditOptions): Promise<Record<string, unknown>> {
  imagesEdit.mockResolvedValue({ data: [{ b64_json: 'RURJVA==' }] });
  await makeService().edit(PNG_DATA_URL, 'make it blue', options);
  expect(imagesEdit).toHaveBeenCalledTimes(1);
  return imagesEdit.mock.calls[0][0] as Record<string, unknown>;
}

describe('OpenAIImageService.edit', () => {
  beforeEach(() => {
    imagesEdit.mockReset();
  });

  it('forwards a valid preset size for a gpt-image-1 family model', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_1_5, size: '1536x1024' });

    expect(params.model).toBe(ImageModels.GPT_IMAGE_1_5);
    expect(params.size).toBe('1536x1024');
  });

  it('omits a dall-e-2 size when the edit model is a gpt-image model', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_1_5, size: '512x512' });

    expect(params).not.toHaveProperty('size');
  });

  it('forwards a gpt-image-2 preset size', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, size: '2048x2048' });

    expect(params.size).toBe('2048x2048');
  });

  it('forwards an arbitrary gpt-image-2 resolution that meets the constraints', async () => {
    // gpt-image-2 accepts any conforming WIDTHxHEIGHT, so validating against the preset
    // list alone dropped custom sizes and silently fell back to OpenAI's default.
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, size: '1920x1088' });

    expect(params.size).toBe('1920x1088');
  });

  it('omits a gpt-image-2 resolution that violates the constraints', async () => {
    // 1080 is not a multiple of 16, so this common video size is genuinely unsupported.
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, size: '1920x1080' });

    expect(params).not.toHaveProperty('size');
  });

  it('sends the image as an array and no dall-e-2 only parameters for gpt-image models', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, size: '1024x1024' });

    expect(Array.isArray(params.image)).toBe(true);
    expect(params).not.toHaveProperty('n');
    expect(params).not.toHaveProperty('response_format');
    expect(params).not.toHaveProperty('user');
  });

  it('forwards the mask when one is supplied to a gpt-image model', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, mask: PNG_DATA_URL });

    expect(params.mask).toBeInstanceOf(File);
  });

  it('omits the mask key entirely when none is supplied to a gpt-image model', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2 });

    expect(params).not.toHaveProperty('mask');
  });

  it('forwards quality to a gpt-image model, which callers have already billed for', async () => {
    // ImageEdit.ts and the chat edit_image tool both price the requested tier before
    // calling here, so dropping it charges for a tier OpenAI was never asked to render.
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, quality: 'high' });

    expect(params.quality).toBe('high');
  });

  it.each([
    ['standard', 'medium'],
    ['hd', 'high'],
  ])("maps the legacy '%s' tier to '%s' on the edit endpoint", async (requested, expected) => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, quality: requested as 'standard' | 'hd' });

    expect(params.quality).toBe(expected);
  });

  it('omits quality entirely when none is requested', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2 });

    expect(params).not.toHaveProperty('quality');
  });

  it('drops a transparent background for gpt-image-2 on the edit endpoint, which would 400', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_2, background: 'transparent' });

    expect(params).not.toHaveProperty('background');
  });

  it('keeps a transparent background for gpt-image-1.5 on the edit endpoint', async () => {
    const params = await editParams({ model: ImageModels.GPT_IMAGE_1_5, background: 'transparent' });

    expect(params.background).toBe('transparent');
  });

  it('leaves the dall-e-2 request shape unchanged', async () => {
    const params = await editParams({
      model: ImageModels.DALL_E_2,
      size: '512x512',
      mask: PNG_DATA_URL,
      n: 2,
      response_format: 'url',
      user: 'user-1',
    });

    expect(params.model).toBe(ImageModels.DALL_E_2);
    expect(params.image).toBeInstanceOf(File);
    expect(Array.isArray(params.image)).toBe(false);
    expect(params.mask).toBeInstanceOf(File);
    expect(params.n).toBe(2);
    expect(params.size).toBe('512x512');
    expect(params.response_format).toBe('url');
    expect(params.user).toBe('user-1');
  });
});

describe('OpenAIImageService.generate gpt-image-2 sizing', () => {
  beforeEach(() => {
    imagesGenerate.mockReset();
  });

  /** Runs generate() against the mocked SDK and returns the params it sent. */
  async function generateParams(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: 'R0VO' }] });
    await makeService().generate('a bicycle', options);
    return imagesGenerate.mock.calls[0][0] as Record<string, unknown>;
  }

  it('keeps a custom resolution that meets the constraints', async () => {
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_2, size: '1920x1088' });

    expect(params.size).toBe('1920x1088');
  });

  it('falls back to 1024x1024 for a resolution that violates a constraint', async () => {
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_2, size: '1920x1080' });

    expect(params.size).toBe('1024x1024');
  });

  it('leaves a size it cannot parse untouched', async () => {
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_2, size: 'wide' });

    expect(params.size).toBe('wide');
  });

  it("defaults to 'auto' when no size is supplied", async () => {
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_2 });

    expect(params.size).toBe('auto');
  });
});

describe('OpenAIImageService.generate gpt-image quality forwarding (#2742)', () => {
  beforeEach(() => {
    imagesGenerate.mockReset();
    imagesEdit.mockReset();
    vi.mocked(downloadImageAsBuffer).mockReset();
  });

  /** Runs generate() against the mocked SDK and returns the params it sent. */
  async function generateParams(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    imagesGenerate.mockResolvedValue({ data: [{ b64_json: 'R0VO' }] });
    await makeService().generate('a bicycle', options);
    return imagesGenerate.mock.calls[0][0] as Record<string, unknown>;
  }

  it.each(['low', 'medium', 'high', 'auto'] as const)(
    "forwards a '%s' quality value to the OpenAI generate call instead of stripping it",
    async quality => {
      // ImageGeneration.ts's validateUserCredits bills this exact tier before reaching
      // here - if it's stripped, the user pays for a quality they never receive.
      const params = await generateParams({ model: ImageModels.GPT_IMAGE_1_5, quality });

      expect(params.quality).toBe(quality);
    }
  );

  it('drops an out-of-enum quality value rather than sending an invalid enum to OpenAI', async () => {
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_1_5, quality: 'ultra' });

    expect(params).not.toHaveProperty('quality');
  });

  it.each([
    ['standard', 'medium'],
    ['hd', 'high'],
  ])("maps the legacy '%s' tier to '%s' rather than dropping it", async (requested, expected) => {
    // The cost calculator bills 'standard'/'hd' as medium/high, so mapping (not dropping)
    // is what keeps the charge and the render on the same tier.
    const params = await generateParams({ model: ImageModels.GPT_IMAGE_1_5, quality: requested });

    expect(params.quality).toBe(expected);
  });

  /** Runs the image-to-image branch of generate() and returns the params sent to images.edit. */
  async function imageToImageParams(options: Record<string, unknown>): Promise<Record<string, unknown>> {
    vi.mocked(downloadImageAsBuffer).mockResolvedValue(Buffer.from('fake-source-image'));
    imagesEdit.mockResolvedValue({ data: [{ b64_json: 'RURJVA==' }] });
    await makeService().generate('a bicycle', { imagePrompt: 'https://example.com/source.png', ...options });
    expect(imagesEdit).toHaveBeenCalledTimes(1);
    return imagesEdit.mock.calls[0][0] as Record<string, unknown>;
  }

  it('forwards quality on the image-to-image (edit-endpoint) branch too', async () => {
    // generate() routes imagePrompt requests through images.edit for GPT-Image models;
    // validateUserCredits bills the same mapped tier for this branch, so it must not
    // silently drop quality the way the text-to-image branch used to.
    const params = await imageToImageParams({ model: ImageModels.GPT_IMAGE_1_5, quality: 'high' });

    expect(params.quality).toBe('high');
  });

  it('forwards n on the image-to-image branch, since credits are charged per image', async () => {
    // validateUserCredits charges usdCost * n up front; requesting 3 and sending none
    // bills for three images and returns one.
    const params = await imageToImageParams({ model: ImageModels.GPT_IMAGE_1_5, n: 3 });

    expect(params.n).toBe(3);
  });

  it('forwards the normalized size on the image-to-image branch', async () => {
    const params = await imageToImageParams({ model: ImageModels.GPT_IMAGE_1_5, size: '1536x1024' });

    expect(params.size).toBe('1536x1024');
  });

  it("maps the legacy 'hd' tier to 'high' on the image-to-image branch too", async () => {
    const params = await imageToImageParams({ model: ImageModels.GPT_IMAGE_1_5, quality: 'hd' });

    expect(params.quality).toBe('high');
  });

  it('drops an out-of-enum quality value on the image-to-image branch rather than sending it', async () => {
    const params = await imageToImageParams({ model: ImageModels.GPT_IMAGE_1_5, quality: 'ultra' });

    expect(params).not.toHaveProperty('quality');
  });

  it('logs a warning when a quality value is dropped, so the drop is observable', async () => {
    const debugSpy = vi.spyOn(Logger.globalInstance, 'debug');

    await generateParams({ model: ImageModels.GPT_IMAGE_1_5, quality: 'ultra' });

    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining('parameter adjustments'),
      expect.arrayContaining([expect.stringContaining("Quality parameter ('ultra')")])
    );
    debugSpy.mockRestore();
  });

  it('returns every generated image, not just the first, when OpenAI returns more than one', async () => {
    imagesEdit.mockResolvedValue({
      data: [{ b64_json: 'aW1hZ2Ux' }, { b64_json: 'aW1hZ2Uy' }, { b64_json: 'aW1hZ2Uz' }],
    });
    vi.mocked(downloadImageAsBuffer).mockResolvedValue(Buffer.from('fake-source-image'));

    const images = await makeService().generate('a bicycle', {
      model: ImageModels.GPT_IMAGE_1_5,
      imagePrompt: 'https://example.com/source.png',
      n: 3,
    });

    expect(images).toHaveLength(3);
  });
});
