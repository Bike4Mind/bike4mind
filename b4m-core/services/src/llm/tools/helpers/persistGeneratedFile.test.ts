import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import type { ToolContext } from '../base/types';

const { mockCreateFabFile } = vi.hoisted(() => ({ mockCreateFabFile: vi.fn() }));
vi.mock('../../../fabFileService/create', () => ({ createFabFile: mockCreateFabFile }));

import { persistGeneratedFileAsFabFile, saveGeneratedAssetFromTool } from './persistGeneratedFile';

function makeContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    sessionId: 's1',
    questId: 'q1',
    logger: { warn: vi.fn(), error: vi.fn() },
    db: { fabfiles: {}, users: {}, adminSettings: {}, dataLakes: {} },
    storage: { upload: vi.fn(), getSignedUrl: vi.fn() },
    ...over,
  } as unknown as ToolContext;
}

const audio = { fileName: 'speech.mp3', mimeType: 'audio/mpeg', content: Buffer.from('x'), type: KnowledgeType.AUDIO };

describe('persistGeneratedFileAsFabFile', () => {
  beforeEach(() => mockCreateFabFile.mockReset());

  it('links the file to its session through provenance, not the summary-only sessionId field', async () => {
    await persistGeneratedFileAsFabFile(makeContext(), audio);

    expect(mockCreateFabFile).toHaveBeenCalledTimes(1);
    const [userId, params, adapters] = mockCreateFabFile.mock.calls[0];
    expect(userId).toBe('u1');
    expect(params).not.toHaveProperty('sessionId');
    expect(params.type).toBe(KnowledgeType.AUDIO);
    expect(adapters.provenance).toEqual({
      sourceType: FabFileSourceType.TOOL_GENERATED,
      sourceMetadata: { sessionId: 's1', questId: 'q1' },
    });
  });

  it('omits questId from the provenance when the context has none', async () => {
    await persistGeneratedFileAsFabFile(makeContext({ questId: undefined }), audio);

    expect(mockCreateFabFile.mock.calls[0][2].provenance.sourceMetadata).toEqual({ sessionId: 's1' });
  });

  it('skips persisting when there is no session to link the file to', async () => {
    await persistGeneratedFileAsFabFile(makeContext({ sessionId: undefined }), audio);

    expect(mockCreateFabFile).not.toHaveBeenCalled();
  });

  it('forwards the tool adapters with scopedSettings and the remapped storage to createFabFile', async () => {
    const scopedSettings = { findOverrides: vi.fn() };
    const context = makeContext({
      db: { fabfiles: {}, users: {}, adminSettings: {}, dataLakes: {}, scopedSettings } as unknown as ToolContext['db'],
    });

    await persistGeneratedFileAsFabFile(context, audio);

    const { db, storage } = mockCreateFabFile.mock.calls[0][2];
    expect(db.scopedSettings).toBe(scopedSettings);
    const content = Buffer.from('bytes');
    await storage.upload('generated/a.mp3', content, { ContentType: 'audio/mpeg' });
    expect(context.storage.upload).toHaveBeenCalledWith(content, 'generated/a.mp3', { ContentType: 'audio/mpeg' });
  });

  // One key at a time (not an all-empty db), so dropping any single clause of the four-way guard fails here.
  it.each(['fabfiles', 'users', 'adminSettings', 'dataLakes'] as const)(
    'skips and warns when the harness supplies no %s adapter',
    async missing => {
      const db: Record<string, unknown> = { fabfiles: {}, users: {}, adminSettings: {}, dataLakes: {} };
      delete db[missing];
      const context = makeContext({ db: db as unknown as ToolContext['db'] });

      await persistGeneratedFileAsFabFile(context, audio);

      expect(mockCreateFabFile).not.toHaveBeenCalled();
      expect(context.logger.warn).toHaveBeenCalled();
    }
  );

  it('swallows a create failure so the tool itself still succeeds', async () => {
    mockCreateFabFile.mockRejectedValueOnce(new Error('quota'));
    const context = makeContext();

    await expect(persistGeneratedFileAsFabFile(context, audio)).resolves.toBeUndefined();
    expect(context.logger.error).toHaveBeenCalled();
  });
});

describe('saveGeneratedAssetFromTool', () => {
  const generation = { generator: 'speech' as const, provider: 'openai', modelId: 'tts-1', prompt: 'hello' };
  const asset = { bytes: Buffer.from('x'), contentType: 'audio/mpeg', generation };

  beforeEach(() => {
    mockCreateFabFile.mockReset();
    mockCreateFabFile.mockResolvedValue({ id: 'f1', fileName: 'speech.mp3', filePath: 'generated-audio/f1.mp3' });
  });

  it('links the asset to its notebook alongside the generation provenance', async () => {
    const result = await saveGeneratedAssetFromTool(makeContext(), asset);

    expect(result).toMatchObject({ saved: true, fileId: 'f1' });
    const [userId, , adapters] = mockCreateFabFile.mock.calls[0];
    expect(userId).toBe('u1');
    expect(adapters.provenance).toEqual({
      sourceType: FabFileSourceType.TOOL_GENERATED,
      sourceMetadata: { sessionId: 's1', questId: 'q1', generation },
    });
  });

  it('adapts the tool storage argument order and forwards scopedSettings', async () => {
    const scopedSettings = { findOverrides: vi.fn() };
    const context = makeContext({
      db: { fabfiles: {}, users: {}, adminSettings: {}, dataLakes: {}, scopedSettings } as unknown as ToolContext['db'],
    });

    await saveGeneratedAssetFromTool(context, asset);

    const { db, storage } = mockCreateFabFile.mock.calls[0][2];
    expect(db.scopedSettings).toBe(scopedSettings);
    const content = Buffer.from('bytes');
    await storage.upload('generated-audio/a.mp3', content, { ContentType: 'audio/mpeg' });
    expect(context.storage.upload).toHaveBeenCalledWith(content, 'generated-audio/a.mp3', {
      ContentType: 'audio/mpeg',
    });
    await storage.generateSignedUrl('generated-audio/a.mp3', 60);
    expect(context.storage.getSignedUrl).toHaveBeenCalledWith('generated-audio/a.mp3', 'get', { expiresIn: 60 });
    // createFabFile mints a 'put' URL for the upload leg, so the verb must survive the remap, not default to 'get'.
    await storage.generateSignedUrl('generated-audio/a.mp3', 60, 'put');
    expect(context.storage.getSignedUrl).toHaveBeenCalledWith('generated-audio/a.mp3', 'put', { expiresIn: 60 });
  });

  it('skips the save when the harness supplies no file adapters', async () => {
    const context = makeContext({ db: {} as ToolContext['db'] });

    await expect(saveGeneratedAssetFromTool(context, asset)).resolves.toEqual({ saved: false, reason: 'error' });
    expect(mockCreateFabFile).not.toHaveBeenCalled();
  });
});
