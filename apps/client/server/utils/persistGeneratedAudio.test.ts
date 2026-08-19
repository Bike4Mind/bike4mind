import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KnowledgeType } from '@bike4mind/common';

// Seams: persistGeneratedAudio routes through fabFilesService.createFabFile and
// the files-bucket storage. We mock both so the test exercises only this
// helper's contract: what it passes to createFabFile, and how it maps a
// createFabFile failure to a non-fatal result (audio must never be dropped).
const h = vi.hoisted(() => ({ createFabFile: vi.fn() }));

vi.mock('@bike4mind/services', () => ({
  fabFilesService: { createFabFile: h.createFabFile },
}));
vi.mock('@bike4mind/database', () => ({
  FabFile: {},
  User: {},
  adminSettingsRepository: {},
  dataLakeRepository: {},
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ upload: vi.fn(), getSignedUrl: vi.fn() })),
}));

import { persistGeneratedAudio } from './persistGeneratedAudio';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

describe('persistGeneratedAudio', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists TTS audio as an AUDIO FabFile and returns the saved reference', async () => {
    h.createFabFile.mockResolvedValue({ id: 'fab-1', fileUrl: 'https://s3/get' });

    const result = await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/mpeg',
      source: 'tts',
      text: 'Hello there',
      logger,
    });

    expect(result).toEqual({
      saved: true,
      fabFileId: 'fab-1',
      fileName: expect.stringMatching(/\.mp3$/),
      fileUrl: 'https://s3/get',
    });

    const [userId, params] = h.createFabFile.mock.calls[0];
    expect(userId).toBe('u1');
    expect(params.type).toBe(KnowledgeType.AUDIO);
    expect(params.mimeType).toBe('audio/mpeg');
    expect(params.prefix).toBe('generated-audio');
    expect(params.tags).toEqual([
      { name: 'generated', strength: 1 },
      { name: 'tts', strength: 1 },
    ]);
    // The prompt is folded into a friendly, sanitized file name.
    expect(params.fileName).toMatch(/^speech-Hello-there-\d+\.mp3$/);
  });

  it('tags sound-effect audio with its source', async () => {
    h.createFabFile.mockResolvedValue({ id: 'fab-2' });
    await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/wav',
      source: 'sound-effect',
      logger,
    });
    const [, params] = h.createFabFile.mock.calls[0];
    expect(params.tags).toContainEqual({ name: 'sound-effect', strength: 1 });
    expect(params.fileName).toMatch(/^sound-effect-\d+\.wav$/);
  });

  it('tags music audio with its source', async () => {
    h.createFabFile.mockResolvedValue({ id: 'fab-3' });
    await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/mpeg',
      source: 'music',
      text: 'lofi beat',
      logger,
    });
    const [, params] = h.createFabFile.mock.calls[0];
    expect(params.tags).toContainEqual({ name: 'music', strength: 1 });
    expect(params.fileName).toMatch(/^music-lofi-beat-\d+\.mp3$/);
  });

  it('maps a storage-quota rejection to saved:false without throwing (audio must still be returned)', async () => {
    h.createFabFile.mockRejectedValue(new Error('File size exceeds storage limit'));
    const result = await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/mpeg',
      source: 'tts',
      logger,
    });
    expect(result).toEqual({ saved: false, reason: 'storage_limit' });
  });

  it('maps a max-file-size rejection to file_too_large', async () => {
    h.createFabFile.mockRejectedValue(new Error('File size exceeds maximum file size'));
    const result = await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/mpeg',
      source: 'tts',
      logger,
    });
    expect(result).toEqual({ saved: false, reason: 'file_too_large' });
  });

  it('maps an unexpected error to reason:error and logs it', async () => {
    h.createFabFile.mockRejectedValue(new Error('mongo exploded'));
    const result = await persistGeneratedAudio({
      userId: 'u1',
      audio: Buffer.from('bytes'),
      contentType: 'audio/mpeg',
      source: 'tts',
      logger,
    });
    expect(result).toEqual({ saved: false, reason: 'error' });
    expect(logger.error).toHaveBeenCalled();
  });
});
