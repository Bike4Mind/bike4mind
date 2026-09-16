import { describe, it, expect, vi, beforeEach } from 'vitest';
import OpenAI from 'openai';
import { Logger } from '@bike4mind/observability';
import { ImageModels } from '@bike4mind/common';

// Stub only the client constructor; the real module is kept so `OpenAI.APIError`
// still resolves for buildModerationBlockedError's instanceof checks.
const generateMock = vi.fn();
vi.mock('openai', async importOriginal => {
  const actual = await importOriginal<typeof import('openai')>();
  function MockOpenAI(this: Record<string, unknown>) {
    this.images = { generate: (...args: unknown[]) => generateMock(...args) };
  }
  Object.assign(MockOpenAI, actual.default);
  return { ...actual, default: MockOpenAI };
});
import { buildModerationBlockedError, OpenAIImageService, resolveGptImageOutputOptions } from './OpenAIImageService';

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
});

describe('OpenAIImageService.generate output controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateMock.mockResolvedValue({ created: 0, output_format: 'png', data: [{ b64_json: 'QUJD' }] });
  });

  const service = () => new OpenAIImageService('test-key', new Logger());

  it('sends background and output_format to gpt-image so a cutout PNG is possible', async () => {
    await service().generate('an inventory icon', {
      model: ImageModels.GPT_IMAGE_2,
      background: 'transparent',
      output_format: 'png',
    });

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateMock.mock.calls[0][0]).toMatchObject({ background: 'transparent', output_format: 'png' });
  });

  it('drops both for a legacy (non gpt-image) model, which would reject them', async () => {
    generateMock.mockResolvedValue({ created: 0, data: [{ url: 'https://example.test/i.png' }] });

    await service().generate('an inventory icon', {
      model: ImageModels.DALL_E_2,
      background: 'transparent',
      output_format: 'webp',
    });

    const sent = generateMock.mock.calls[0][0];
    expect(sent.background).toBeUndefined();
    expect(sent.output_format).toBeUndefined();
  });

  it('labels the data URL with the format the response reports, not always png', async () => {
    generateMock.mockResolvedValue({ created: 0, output_format: 'webp', data: [{ b64_json: 'QUJD' }] });

    const [image] = await service().generate('an inventory icon', {
      model: ImageModels.GPT_IMAGE_2,
      output_format: 'webp',
    });

    expect(image).toBe('data:image/webp;base64,QUJD');
  });
});
