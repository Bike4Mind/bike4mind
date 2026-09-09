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

import { buildModerationBlockedError, isSupportedEditSize, OpenAIImageService } from './OpenAIImageService';

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
