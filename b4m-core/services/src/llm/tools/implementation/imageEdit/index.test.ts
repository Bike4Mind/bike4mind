import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
import { ImageModels, IMAGES_PER_EDIT_REQUEST, type GenerateImageToolCall } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';

// The agent-tool edit_image path must run the SAME moderation gate the
// queue-handler ImageEdit service uses, before context.imageGenerateStorage.upload().
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

// Mocks for the edit_image toolFn's OpenAI branch - see the 'imageEditTool - OpenAI branch'
// describe below. Same constructor-function pattern as RekognitionImageModerationService above.
const mockEditSpy = vi.fn();
const mockBflEditSpy = vi.fn();
vi.mock('@bike4mind/utils', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/utils')>();
  return {
    ...actual,
    OpenAIImageService: vi.fn().mockImplementation(function () {
      return { edit: mockEditSpy };
    }),
    BFLImageService: vi.fn().mockImplementation(function () {
      return { edit: mockBflEditSpy };
    }),
  };
});

vi.mock('../../../../apiKeyService', () => ({
  getEffectiveApiKey: vi.fn().mockResolvedValue('fake-openai-key'),
}));

// Only for the self-host storage-provenance tests below - `downloadImageAsBuffer` runs for
// real (it is not part of the `@bike4mind/utils` mock above), so its HTTP fetch must be
// intercepted here rather than hitting the network. `isAxiosError` and everything else on the
// module stay real so `imageUrlToBase64`'s error-mapping catch keeps working.
const { mockAxiosGet } = vi.hoisted(() => ({ mockAxiosGet: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return {
    ...actual,
    default: { ...actual.default, get: mockAxiosGet },
  };
});

// Imported after the mocks so `processAndStoreImage` and `imageEditTool` pick up the mocked services.
const { processAndStoreImage, getImageFromFileId, imageEditTool } = await import('./index');

// 1x1 transparent PNG - downloadImageAsBuffer() short-circuits data: URLs with no network call.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createFakeContext(): ToolContext {
  return {
    userId: 'u1',
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

// Builds a context whose `db.fabfiles.findAccessibleInIds` resolves to the given fabFile stub
// (null -> [], the shape the repo returns when the caller cannot access the id), and whose
// `storage.getSignedUrl` is mockable - everything `getImageFromFileId` touches.
function createFakeContextWithFabFile(fabFile: Record<string, unknown> | null): ToolContext {
  const context = createFakeContext();
  (context.db as unknown as { fabfiles: { findAccessibleInIds: ReturnType<typeof vi.fn> } }).fabfiles = {
    findAccessibleInIds: vi.fn().mockResolvedValue(fabFile ? [fabFile] : []),
  };
  context.storage = {
    upload: vi.fn(),
    getSignedUrl: vi.fn().mockResolvedValue('https://signed.example/image.png'),
    getPublicUrl: vi.fn(),
  } as unknown as ToolContext['storage'];
  return context;
}

describe('getImageFromFileId serveability guard (sibling of the upload/edit agent-tool bypass fix)', () => {
  // 24-char hex - must pass getImageFromFileId's ObjectId-shape check to reach the FabFile lookup.
  const VALID_FILE_ID = 'a'.repeat(24);

  it('refuses a held (pending) image — no signed URL is minted', async () => {
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'pending',
      filePath: 'pending.png',
    });

    await expect(getImageFromFileId(VALID_FILE_ID, context)).rejects.toThrow('This image is not available.');
    expect(context.storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a blocked image — no signed URL is minted', async () => {
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'blocked',
      filePath: 'blocked.png',
    });

    await expect(getImageFromFileId(VALID_FILE_ID, context)).rejects.toThrow('This image is not available.');
    expect(context.storage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('denies a file the caller cannot access - NotFoundError, no signed URL minted', async () => {
    // Repo returns [] when the id is not owned by / shared with the caller (the IDOR fix): the
    // tool must not distinguish "not found" from "not yours", and must never sign the file.
    const context = createFakeContextWithFabFile(null);

    await expect(getImageFromFileId(VALID_FILE_ID, context)).rejects.toThrow(`File with ID ${VALID_FILE_ID} not found`);
    expect(context.storage.getSignedUrl).not.toHaveBeenCalled();
    // Pin the principal that reaches the repo: the lookup runs as the caller (context.userId),
    // never a widened one, and carries a lakeAccess arm so the denial cannot be an artifact of an
    // over-narrow query. (lakeAccess resolves to {} here - the fake context wires no lake repos.)
    const findAccessibleInIds = (
      context.db as unknown as { fabfiles: { findAccessibleInIds: ReturnType<typeof vi.fn> } }
    ).fabfiles.findAccessibleInIds;
    expect(findAccessibleInIds).toHaveBeenCalledWith(
      [VALID_FILE_ID],
      { userId: context.userId, userGroups: undefined },
      expect.anything()
    );
  });

  it('resolves a signed URL for a clean image, marked as trusted storage provenance', async () => {
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'clean',
      filePath: 'clean.png',
    });

    const resolved = await getImageFromFileId(VALID_FILE_ID, context);

    expect(resolved).toEqual({ url: 'https://signed.example/image.png', trustConfiguredStorageOrigin: true });
    expect(context.storage.getSignedUrl).toHaveBeenCalledWith('clean.png');
  });

  it('resolves an unsigned fileUrl fallback as untrusted', async () => {
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'clean',
      fileUrl: 'https://external.example/already-hosted.png',
    });

    const resolved = await getImageFromFileId(VALID_FILE_ID, context);

    expect(resolved).toEqual({
      url: 'https://external.example/already-hosted.png',
      trustConfiguredStorageOrigin: false,
    });
    expect(context.storage.getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('edit_image processAndStoreImage moderation gate (agent-tool serve-gate bypass)', () => {
  beforeEach(() => {
    mockCheckImage.mockReset();
  });

  it('block: moderation rejects the edited image — upload is NOT called and the call rejects', async () => {
    mockCheckImage.mockRejectedValue(
      new ImageModerationBlockedError([{ name: 'Explicit Nudity', parentName: '', confidence: 99.1 }])
    );
    const context = createFakeContext();

    await expect(processAndStoreImage(PNG_DATA_URL, context, 'gpt-image-1-5', 'openai')).rejects.toBeInstanceOf(
      ImageModerationBlockedError
    );

    expect(context.imageGenerateStorage.upload).not.toHaveBeenCalled();
  });

  it('clean image: moderation passes — upload IS called', async () => {
    mockCheckImage.mockResolvedValue(undefined);
    const context = createFakeContext();

    const result = await processAndStoreImage(PNG_DATA_URL, context, 'gpt-image-1-5', 'openai');

    expect(mockCheckImage).toHaveBeenCalledTimes(1);
    expect(context.imageGenerateStorage.upload).toHaveBeenCalledTimes(1);
    expect(result).toBe('generated/stored-key.png');
  });
});

describe('imageEditTool - OpenAI branch', () => {
  beforeEach(() => {
    mockEditSpy.mockReset();
    // Stop right after dispatch: the assertion is about what reached the provider,
    // not about the post-edit moderation/storage pipeline.
    mockEditSpy.mockRejectedValue(new Error('stop-after-dispatch'));
  });

  it('forwards the requested quality to the OpenAI edit service', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
      quality: 'high',
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it blue' });

    expect(mockEditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ quality: 'high' })
    );
  });

  it('steps a gpt-image-2 edit model down to gpt-image-1.5 when background is transparent', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      editModel: ImageModels.GPT_IMAGE_2,
      background: 'transparent',
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'remove the background' });

    expect(mockEditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5, background: 'transparent' })
    );
    expect(context.onStart).toHaveBeenCalledWith(
      'edit_image',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5 })
    );
  });
});

// Billing must name the model that actually renders. `editModel` is resolved
// independently of the configured generation model and falls back to a hardcoded
// default when imageConfig.editModel is unset, so the two routinely diverge - and the
// provider invoice follows `editModel`. Same invariant as the queue path (ImageEdit.ts).
describe('imageEditTool - credit reservation names the rendered model', () => {
  beforeEach(() => {
    mockEditSpy.mockReset();
    mockBflEditSpy.mockReset();
    // Stop right after dispatch: these assertions are about the onStart payload, which
    // is emitted before the provider call, not about the post-edit storage pipeline.
    mockEditSpy.mockRejectedValue(new Error('stop-after-dispatch'));
    mockBflEditSpy.mockRejectedValue(new Error('stop-after-dispatch'));
  });

  it('bills FLUX_PRO_FILL for a BFL generation model with no explicit editModel', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.FLUX_PRO_1_1,
    } as GenerateImageToolCall);

    // A mask is supplied so the BFL branch skips generateFullMask (sharp) and goes
    // straight to the provider call.
    await toolFn({ image: PNG_DATA_URL, mask: PNG_DATA_URL, prompt: 'make it warmer' });

    expect(context.onStart).toHaveBeenCalledWith(
      'edit_image',
      expect.objectContaining({ model: ImageModels.FLUX_PRO_FILL })
    );
    expect(mockBflEditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: ImageModels.FLUX_PRO_FILL })
    );
  });

  it('bills GPT_IMAGE_1_5 for a non-editable OpenAI generation model with no explicit editModel', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    // DALL-E 3 cannot edit at all, so the fallback lands on GPT_IMAGE_1_5 - the widest
    // possible gap between the configured generation model and what actually renders.
    const { toolFn } = imageEditTool.implementation(context, {
      model: 'dall-e-3',
    } as unknown as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it warmer' });

    expect(context.onStart).toHaveBeenCalledWith(
      'edit_image',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5 })
    );
    expect(mockEditSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_5 })
    );
  });

  it('bills the explicitly configured editModel when one is set', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.FLUX_PRO_1_1,
      editModel: ImageModels.GPT_IMAGE_1_MINI,
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it warmer' });

    expect(context.onStart).toHaveBeenCalledWith(
      'edit_image',
      expect.objectContaining({ model: ImageModels.GPT_IMAGE_1_MINI })
    );
  });
});

describe('imageEditTool - credit reservation counts the image that renders', () => {
  beforeEach(() => {
    mockEditSpy.mockReset();
    // Same stop-after-dispatch trick as the block above: onStart fires before the provider call.
    mockEditSpy.mockRejectedValue(new Error('stop-after-dispatch'));
  });

  // onStart is the single payload both credit rails bill from - ToolBuilder.reserveImageCredits
  // for classic chat and estimateGeneratedMediaUsd for agent mode - so an n above 1 reaching it
  // overcharged on both, for images edit() has never been able to return.
  it('reserves one image however many the model asks for', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it warmer', n: 5 });

    expect(context.onStart).toHaveBeenCalledWith('edit_image', expect.objectContaining({ n: IMAGES_PER_EDIT_REQUEST }));
  });

  it('reserves one image however many the image settings ask for', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
      n: 5,
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it warmer' });

    expect(context.onStart).toHaveBeenCalledWith('edit_image', expect.objectContaining({ n: IMAGES_PER_EDIT_REQUEST }));
  });

  it('does not offer the provider an image count it would render and we would discard', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();

    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    await toolFn({ image: PNG_DATA_URL, prompt: 'make it warmer', n: 5 });

    expect(mockEditSpy.mock.calls[0][2]).not.toHaveProperty('n');
  });

  it('stops advertising an image count the edit path cannot honor', () => {
    const { toolSchema } = imageEditTool.implementation(createFakeContext(), {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);
    const { properties } = toolSchema.parameters as { properties: Record<string, unknown> };

    expect(properties).not.toHaveProperty('n');
  });
});

// Regression for the self-host storage-provenance gap a reviewer found in this tool's own
// resolution layer: `resolveImageInputUrl` must carry whether a URL was freshly minted by
// `getSignedUrl()` through to `downloadImageAsBuffer`, and a literal caller-supplied URL that
// merely shares the configured storage origin must never inherit that trust.
describe('imageEditTool - self-host storage provenance (source and mask)', () => {
  const VALID_FILE_ID = 'b'.repeat(24);

  beforeEach(() => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    mockAxiosGet.mockReset();
    mockEditSpy.mockReset();
    // Stop right after dispatch - these assertions are about whether the download/provider
    // stage was reached, not about the post-edit moderation/storage pipeline.
    mockEditSpy.mockRejectedValue(new Error('stop-after-dispatch'));
  });

  afterEach(() => {
    delete process.env.AWS_ENDPOINT_URL_S3;
  });

  it('blocks a literal URL on the configured storage origin used directly as the source image', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();
    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    await expect(toolFn({ image: 'http://minio:9000/admin/health', prompt: 'x' })).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockEditSpy).not.toHaveBeenCalled();
  });

  it('blocks a literal URL on the configured storage origin used directly as the mask', async () => {
    const context = createFakeContext();
    context.onStart = vi.fn();
    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    await expect(toolFn({ image: PNG_DATA_URL, mask: 'http://minio:9000/admin/health', prompt: 'x' })).rejects.toThrow(
      /blocked for security reasons/
    );
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockEditSpy).not.toHaveBeenCalled();
  });

  it('allows a self-host signed URL resolved from a fabFile id as the source image', async () => {
    mockAxiosGet.mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('png-bytes') });
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'clean',
      filePath: 'clean.png',
    });
    context.storage.getSignedUrl = vi.fn().mockResolvedValue('http://minio:9000/bucket/clean.png?X-Amz-Signature=abc');
    context.onStart = vi.fn();
    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    // The OpenAI branch catches the provider error and returns it as a string result rather
    // than rejecting - the assertion below just needs proof the download (and provider call)
    // was reached, not a particular error-handling shape.
    await expect(toolFn({ image: VALID_FILE_ID, prompt: 'make it warmer' })).resolves.toMatch(/stop-after-dispatch/);

    expect(mockAxiosGet).toHaveBeenCalled();
    expect(mockEditSpy).toHaveBeenCalled();
  });

  it('allows a self-host signed URL resolved from a generated-image key as the mask', async () => {
    mockAxiosGet.mockResolvedValue({ status: 200, headers: {}, data: Buffer.from('png-bytes') });
    const context = createFakeContext();
    context.imageGenerateStorage.getSignedUrl = vi
      .fn()
      .mockResolvedValue('http://minio:9000/bucket/generated-key.png?X-Amz-Signature=abc');
    context.onStart = vi.fn();
    const { toolFn } = imageEditTool.implementation(context, {
      model: ImageModels.GPT_IMAGE_1_5,
    } as GenerateImageToolCall);

    await expect(toolFn({ image: PNG_DATA_URL, mask: 'generated-key.png', prompt: 'make it warmer' })).resolves.toMatch(
      /stop-after-dispatch/
    );

    expect(mockAxiosGet).toHaveBeenCalled();
    expect(mockEditSpy).toHaveBeenCalled();
  });
});
