import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import type { ToolContext } from '../../base/types';

// The agent-tool image_generation path must run the SAME moderation gate the
// queue-handler ImageGeneration service uses, before context.imageGenerateStorage.upload().
// RekognitionImageModerationService is constructed INLINE in the tool (not via ToolContext DI),
// so this test mocks the AWS-calling class itself rather than injecting a fake through context.
const mockCheckImage = vi.fn();

vi.mock('@bike4mind/utils/imageModeration', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils/imageModeration')>();
  return {
    ...actual,
    // Regular `function` (not an arrow) so `new RekognitionImageModerationService(...)` in the
    // tool works - a constructor call requires a real function, and returning an object from it
    // makes `new` yield that object (standard JS constructor-return semantics).
    RekognitionImageModerationService: vi.fn().mockImplementation(function () {
      return { checkImage: mockCheckImage };
    }),
  };
});

// Imported after the mock so `processAndStoreImages` picks up the mocked service.
const { processAndStoreImages, imageGenerationTool } = await import('./index');

// 1x1 transparent PNG - downloadImage() short-circuits data: URLs with no network call.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createFakeContext(): ToolContext {
  return {
    userId: 'u1',
    // any-cast-free minimal fake - only the fields processAndStoreImages/moderateToolImage touch.
    user: {} as ToolContext['user'],
    sessionId: 's1',
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
    } as unknown as ToolContext['logger'],
    db: {
      adminSettings: {
        findAll: vi.fn().mockResolvedValue([{ settingName: 'ImageModerationEnabled', settingValue: 'true' }]),
        findBySettingNames: vi.fn().mockResolvedValue([]),
      },
      imageModerationIncidents: { record: vi.fn().mockResolvedValue(undefined) },
    } as unknown as ToolContext['db'],
    storage: {} as ToolContext['storage'],
    imageGenerateStorage: {
      upload: vi.fn().mockResolvedValue('generated/stored-key.png'),
      getSignedUrl: vi.fn(),
      getPublicUrl: vi.fn(),
    },
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    llm: {} as ToolContext['llm'],
  };
}

describe('image_generation processAndStoreImages moderation gate (agent-tool serve-gate bypass)', () => {
  beforeEach(() => {
    mockCheckImage.mockReset();
  });

  it('block: moderation rejects the image — upload is NOT called and the call rejects', async () => {
    mockCheckImage.mockRejectedValue(
      new ImageModerationBlockedError([{ name: 'Explicit Nudity', parentName: '', confidence: 99.1 }])
    );
    const context = createFakeContext();

    await expect(processAndStoreImages([PNG_DATA_URL], context, 'gpt-image-2', 'openai')).rejects.toBeInstanceOf(
      ImageModerationBlockedError
    );

    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
  });

  it('clean image: moderation passes — upload IS called', async () => {
    mockCheckImage.mockResolvedValue(undefined);
    const context = createFakeContext();

    const result = await processAndStoreImages([PNG_DATA_URL], context, 'gpt-image-2', 'openai');

    expect(mockCheckImage).toHaveBeenCalledTimes(1);
    expect(context.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });
});

describe('image_generation local-image env gating (self-host only)', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  const savedUrl = process.env.IMAGE_GEN_BASE_URL;
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
    if (savedUrl === undefined) delete process.env.IMAGE_GEN_BASE_URL;
    else process.env.IMAGE_GEN_BASE_URL = savedUrl;
  });

  it('refuses to dispatch a local-image model when IMAGE_GEN_BASE_URL is set but B4M_SELF_HOST is not', async () => {
    delete process.env.B4M_SELF_HOST;
    process.env.IMAGE_GEN_BASE_URL = 'http://imagegen:7860';
    const context = createFakeContext();

    const { toolFn } = imageGenerationTool.implementation(context, { model: 'local-image/sd15' });

    // requireApiKey sees no base URL (env ignored outside self-host) and throws
    // the generic "unavailable" error rather than dispatching a free generation.
    await expect(toolFn({ prompt: 'a red bike' })).rejects.toThrow(/unavailable/i);
  });
});
