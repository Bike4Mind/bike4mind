import { FabFileSourceType, KnowledgeType, type GeneratedAssetMetadata } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveGeneratedAsset, type SaveGeneratedAssetDeps, type SaveGeneratedAssetParams } from './saveGeneratedAsset';

const createFabFile = vi.hoisted(() => vi.fn());
vi.mock('../fabFileService/create', () => ({ createFabFile }));

const findOne = vi.fn();
const logger = { info: vi.fn(), error: vi.fn() };
const deps = {
  db: { fabFiles: { create: vi.fn(), findOne }, adminSettings: {}, users: {}, dataLakes: {} },
  storage: { upload: vi.fn(), generateSignedUrl: vi.fn() },
  logger,
} as unknown as SaveGeneratedAssetDeps;

const music: GeneratedAssetMetadata = {
  generator: 'music',
  provider: 'elevenlabs',
  modelId: 'music_v2',
  prompt: 'A sunny pop song!',
  durationSeconds: 60,
};

const params = (overrides: Partial<SaveGeneratedAssetParams> = {}): SaveGeneratedAssetParams => ({
  userId: 'u1',
  bytes: Buffer.from('audio'),
  contentType: 'audio/mpeg',
  generation: music,
  ...overrides,
});

const createdFile = { id: 'f1', fileName: 'music.mp3', filePath: 'generated-audio/x.mp3', fileUrl: 'https://signed' };

describe('saveGeneratedAsset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createFabFile.mockResolvedValue(createdFile);
    findOne.mockResolvedValue(null);
  });

  it('saves with typed provenance, modality tags and claim-first MIME', async () => {
    const result = await saveGeneratedAsset(params({ sessionId: 's1', questId: 'q1' }), deps);

    expect(result).toEqual({
      saved: true,
      fileId: 'f1',
      s3Key: 'generated-audio/x.mp3',
      fileName: 'music.mp3',
      fileUrl: 'https://signed',
    });
    const [userId, fileParams, adapters] = createFabFile.mock.calls[0];
    expect(userId).toBe('u1');
    expect(fileParams).toMatchObject({
      type: KnowledgeType.AUDIO,
      mimeType: 'audio/mpeg',
      contentType: 'audio/mpeg',
      fileSize: 5,
      prefix: 'generated-audio',
      tags: [
        { name: 'generated', strength: 1 },
        { name: 'music', strength: 1 },
      ],
    });
    expect(fileParams.fileName).toMatch(/^music-A-sunny-pop-song-\d+\.mp3$/);
    expect(adapters.mimeTypePrecedence).toBe('claim-first');
    expect(adapters.provenance).toEqual({
      sourceType: FabFileSourceType.TOOL_GENERATED,
      sourceMetadata: { sessionId: 's1', questId: 'q1', generation: music },
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('omits the notebook link when there is no session', async () => {
    await saveGeneratedAsset(params(), deps);

    expect(createFabFile.mock.calls[0][2].provenance.sourceMetadata).toEqual({ generation: music });
  });

  it('stores video as VIDEO under its own prefix, tagged with the job', async () => {
    const generation: GeneratedAssetMetadata = { generator: 'video', provider: 'veo', jobId: 'j1', prompt: 'waves' };
    await saveGeneratedAsset(params({ contentType: 'video/mp4', generation }), deps);

    const fileParams = createFabFile.mock.calls[0][1];
    expect(fileParams).toMatchObject({
      type: KnowledgeType.VIDEO,
      prefix: 'generated-video',
      fileName: 'video-waves-j1.mp4',
    });
    expect(fileParams.tags).toContainEqual({ name: 'job:j1', strength: 1 });
  });

  it('returns the existing file when the job was already saved', async () => {
    findOne.mockResolvedValue({ id: 'f0', fileName: 'video.mp4', filePath: 'generated-video/old.mp4' });
    const generation: GeneratedAssetMetadata = { generator: 'video', provider: 'veo', jobId: 'j1', prompt: 'waves' };

    const result = await saveGeneratedAsset(params({ contentType: 'video/mp4', generation }), deps);

    expect(result).toEqual({ saved: true, fileId: 'f0', s3Key: 'generated-video/old.mp4', fileName: 'video.mp4' });
    expect(findOne).toHaveBeenCalledWith({ userId: 'u1', deletedAt: null, tags: { $elemMatch: { name: 'job:j1' } } });
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it('refuses a content type with no known extension before writing', async () => {
    const generation: GeneratedAssetMetadata = { generator: 'video', provider: 'veo', prompt: 'waves' };

    const result = await saveGeneratedAsset(params({ contentType: 'video/quicktime', generation }), deps);

    expect(result).toEqual({ saved: false, reason: 'error' });
    expect(createFabFile).not.toHaveBeenCalled();
  });

  it.each([
    ['File size exceeds storage limit', 'storage_limit'],
    ['File size exceeds maximum file size', 'file_too_large'],
    ['boom', 'error'],
  ])('maps a %j failure to %s without throwing', async (message, reason) => {
    createFabFile.mockRejectedValue(new Error(message));

    await expect(saveGeneratedAsset(params(), deps)).resolves.toEqual({ saved: false, reason });
  });

  it('reports a created file without a storage path as an error', async () => {
    createFabFile.mockResolvedValue({ ...createdFile, filePath: undefined });

    await expect(saveGeneratedAsset(params(), deps)).resolves.toEqual({ saved: false, reason: 'error' });
  });

  it('rethrows when the signal was aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error('aborted');
    createFabFile.mockRejectedValue(abortError);

    await expect(saveGeneratedAsset(params({ signal: controller.signal }), deps)).rejects.toBe(abortError);
  });
});
