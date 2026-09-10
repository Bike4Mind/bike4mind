import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImageModerationBlockedError } from '@bike4mind/utils/imageModeration';
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

// Imported after the mock so `processAndStoreImage` picks up the mocked service.
const { processAndStoreImage, getImageFromFileId } = await import('./index');

// 1x1 transparent PNG - downloadImage() short-circuits data: URLs with no network call.
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

  it('resolves a signed URL for a clean image', async () => {
    const context = createFakeContextWithFabFile({
      mimeType: 'image/png',
      moderationStatus: 'clean',
      filePath: 'clean.png',
    });

    const url = await getImageFromFileId(VALID_FILE_ID, context);

    expect(url).toBe('https://signed.example/image.png');
    expect(context.storage.getSignedUrl).toHaveBeenCalledWith('clean.png');
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
