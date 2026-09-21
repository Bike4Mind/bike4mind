import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import { ImageModels } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import { PRICEABLE_IMAGE_SIZES } from '../../../imageCostCalculator/OpenAIImageCostCalculator';

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

const mockGeminiGenerate = vi.fn();
const mockOpenAIGenerate = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    GeminiImageService: vi.fn().mockImplementation(function () {
      return { generate: mockGeminiGenerate };
    }),
    OpenAIImageService: vi.fn().mockImplementation(function () {
      return { generate: mockOpenAIGenerate };
    }),
  };
});

vi.mock('../../../../apiKeyService', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apiKeyService')>();
  return { ...actual, getEffectiveApiKey: vi.fn().mockResolvedValue('fake-gemini-key') };
});

// Imported after the mocks so `processAndStoreImages` and the Gemini branch pick up the fakes.
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

describe('image_generation effective-arg precedence (tool call vs client imageConfig)', () => {
  beforeEach(() => {
    mockOpenAIGenerate.mockReset();
    mockOpenAIGenerate.mockResolvedValue([PNG_DATA_URL]);
    mockCheckImage.mockReset();
    mockCheckImage.mockResolvedValue(undefined);
  });

  // The client always sends a fully-populated imageConfig (useSendMessage fills quality from
  // the persisted store), so "client value || tool value" silently discarded every tier the
  // model asked for. The tool call must win; the client value is only a fallback.
  it('a tool-call tier overrides an always-populated client imageConfig quality', async () => {
    const context = createFakeContext();
    const onStart = vi.fn().mockResolvedValue(undefined);
    context.onStart = onStart;

    const { toolFn } = imageGenerationTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_2,
      quality: 'standard',
      size: '1024x1024',
    });

    await toolFn({ prompt: 'a red bike', quality: 'hd' });

    expect(onStart).toHaveBeenCalledWith('image_generation', expect.objectContaining({ quality: 'hd' }));
    expect(mockOpenAIGenerate).toHaveBeenCalledWith('a red bike', expect.objectContaining({ quality: 'hd' }));
  });

  // Billing follows the dispatched args, so what onStart records and what the provider is
  // handed must be the same resolved set - otherwise the ledger describes an image nobody made.
  it('bills the same model, n, size and quality it dispatches', async () => {
    const context = createFakeContext();
    const onStart = vi.fn().mockResolvedValue(undefined);
    context.onStart = onStart;

    const { toolFn } = imageGenerationTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_2,
      n: 2,
      quality: 'low',
      size: '1024x1024',
    });

    await toolFn({ prompt: 'a red bike', n: 1, quality: 'high', size: '1024x1536' });

    const resolved = { model: ImageModels.GPT_IMAGE_2, n: 1, quality: 'high', size: '1024x1536' };
    expect(onStart).toHaveBeenCalledWith('image_generation', expect.objectContaining(resolved));
    expect(mockOpenAIGenerate).toHaveBeenCalledWith('a red bike', expect.objectContaining(resolved));
  });

  // #2889 taught the OpenAI layer to map standard/hd, but the schema still advertised only
  // those two, so "generate it at low quality" could not be expressed at all.
  //
  // #2899 then removed 'auto': it bills at the ceiling tier because OpenAI picks the effort per
  // request, so the model must not be able to reach for it - omitting the field is the way to
  // defer to the user's saved preference, and that costs whatever that preference costs.
  //
  // Pinned exactly rather than with arrayContaining/not.toContain: a future value added to
  // OPENAI_IMAGE_QUALITIES would reach the model unreviewed under a looser assertion.
  it('exposes exactly the model-selectable GPT-image quality tiers in the tool schema', () => {
    const { toolSchema } = imageGenerationTool.implementation(createFakeContext(), { model: ImageModels.GPT_IMAGE_2 });
    const quality = toolSchema.parameters.properties.quality;
    expect(quality.enum).toEqual(['standard', 'hd', 'low', 'medium', 'high']);
  });

  // #2936: the schema advertised five sizes but the calculator prices three, so four of them
  // rendered at the asked-for size and billed at the 1024x1024 row. Offer only priceable sizes.
  it('offers only sizes the cost calculator can price in the tool schema', () => {
    const { toolSchema } = imageGenerationTool.implementation(createFakeContext(), { model: ImageModels.GPT_IMAGE_2 });

    expect(toolSchema.parameters.properties.size.enum).toEqual([...PRICEABLE_IMAGE_SIZES]);
  });

  // The enum is advisory to the model, so the resolver has to hold the line too.
  it('ignores an off-enum model size and bills what it dispatches', async () => {
    const context = createFakeContext();
    const onStart = vi.fn().mockResolvedValue(undefined);
    context.onStart = onStart;

    const { toolFn } = imageGenerationTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_2,
      quality: 'high',
      size: '1536x1024',
    });

    await toolFn({ prompt: 'a red bike', size: '1792x1024' });

    expect(onStart).toHaveBeenCalledWith('image_generation', expect.objectContaining({ size: '1536x1024' }));
    expect(mockOpenAIGenerate).toHaveBeenCalledWith('a red bike', expect.objectContaining({ size: '1536x1024' }));
  });
});

describe('image_generation Gemini branch parameter passthrough', () => {
  // The tool passes safety_tolerance/prompt_upsampling/seed/output_format straight through to
  // GeminiImageService.generate() - buildGenerationConfig() is the single place that refuses to
  // forward prompt_upsampling/seed to Google's API (see GeminiImageService's own test suite),
  // since Google rejects the mere PRESENCE of those two fields. This just confirms the tool isn't
  // dropping anything before it gets there.
  beforeEach(() => {
    mockGeminiGenerate.mockReset();
    mockGeminiGenerate.mockResolvedValue([]);
  });

  it('forwards prompt_upsampling, seed, safety_tolerance, and output_format to GeminiImageService.generate', async () => {
    const context = createFakeContext();

    const { toolFn } = imageGenerationTool.implementation(context, {
      model: ImageModels.GEMINI_2_5_FLASH_IMAGE,
      prompt_upsampling: true,
      seed: 42,
      safety_tolerance: 1,
      output_format: 'jpeg',
    });

    await toolFn({ prompt: 'a red bike' });

    expect(mockGeminiGenerate).toHaveBeenCalledWith(
      'a red bike',
      expect.objectContaining({
        prompt_upsampling: true,
        seed: 42,
        safety_tolerance: 1,
        output_format: 'jpeg',
      })
    );
  });
});

describe('image_generation OpenAI model selection for transparent backgrounds', () => {
  beforeEach(() => {
    mockOpenAIGenerate.mockReset();
    mockOpenAIGenerate.mockResolvedValue([]);
  });

  it('steps a default gpt-image-2 selection down to gpt-image-1.5 when transparency is requested', async () => {
    const context = createFakeContext();

    const { toolFn } = imageGenerationTool.implementation(context, {});

    await toolFn({ prompt: 'an inventory icon', background: 'transparent' });

    expect(mockOpenAIGenerate).toHaveBeenCalledWith(
      'an inventory icon',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5, background: 'transparent' })
    );
  });

  it('steps an explicitly-selected gpt-image-2 down to gpt-image-1.5 when transparency is requested', async () => {
    const context = createFakeContext();

    const { toolFn } = imageGenerationTool.implementation(context, { model: ImageModels.GPT_IMAGE_2 });

    await toolFn({ prompt: 'an inventory icon', background: 'transparent' });

    expect(mockOpenAIGenerate).toHaveBeenCalledWith(
      'an inventory icon',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5, background: 'transparent' })
    );
  });

  it('keeps the gpt-image-2 default when no transparency is requested', async () => {
    const context = createFakeContext();

    const { toolFn } = imageGenerationTool.implementation(context, {});

    await toolFn({ prompt: 'an inventory icon' });

    expect(mockOpenAIGenerate).toHaveBeenCalledWith(
      'an inventory icon',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_2 })
    );
  });
});
