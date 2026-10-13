import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import { createMongoServer } from '../../__test__/createMongoServer';
import { FabFile, fabFileRepository } from './FabFileModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await FabFile.deleteMany({});
});

const userId = 'u-generated';
const sessionId = '64b000000000000000000001';

// The shape persistGeneratedFileAsFabFile writes for an in-chat tool's output.
const createGenerated = (fileName: string, over: Record<string, unknown> = {}) =>
  FabFile.create({
    userId,
    fileName,
    mimeType: 'audio/mpeg',
    type: KnowledgeType.AUDIO,
    filePath: `generated/${fileName}`,
    tags: [{ name: 'generated', strength: 1 }],
    sourceType: FabFileSourceType.TOOL_GENERATED,
    sourceMetadata: { sessionId, questId: 'q1' },
    ...over,
  });

describe('tool-generated FabFiles', () => {
  it('surface in the File Browser search, matching the Audio type filter', async () => {
    await createGenerated('speech.mp3');
    // A notebook summary carries the top-level sessionId and must stay hidden from the browser.
    await FabFile.create({
      userId,
      fileName: 'Notebook Summary.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'summary.txt',
      sessionId,
    });

    const all = await fabFileRepository.search(
      userId,
      '',
      {},
      { page: 1, limit: 50 },
      { by: 'fileName', direction: 'asc' }
    );
    expect(all.data.map(f => f.fileName)).toEqual(['speech.mp3']);

    const audioOnly = await fabFileRepository.search(
      userId,
      '',
      { type: 'audio' },
      { page: 1, limit: 50 },
      { by: 'fileName', direction: 'asc' }
    );
    expect(audioOnly.data.map(f => f.fileName)).toEqual(['speech.mp3']);
  });

  it("findToolGeneratedBySessionId returns only the session's live generated files", async () => {
    await createGenerated('mine.mp3');
    await createGenerated('deleted.mp3', { deletedAt: new Date() });
    await createGenerated('other-session.mp3', { sourceMetadata: { sessionId: '64b000000000000000000002' } });
    await createGenerated('slack.mp3', { sourceType: FabFileSourceType.SLACK });

    const result = await fabFileRepository.findToolGeneratedBySessionId(sessionId);

    expect(result.map(f => f.fileName)).toEqual(['mine.mp3']);
  });

  it('findMetadataBySessionId lists them next to the session-stamped files', async () => {
    await createGenerated('speech.mp3');
    await FabFile.create({
      userId,
      fileName: 'Notebook Summary.txt',
      mimeType: 'text/plain',
      type: KnowledgeType.FILE,
      filePath: 'summary.txt',
      sessionId,
    });

    const result = await fabFileRepository.findMetadataBySessionId(sessionId);

    expect(result.data.map(f => f.fileName).sort()).toEqual(['Notebook Summary.txt', 'speech.mp3']);
  });
});
