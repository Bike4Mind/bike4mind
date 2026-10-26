import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { KnowledgeType } from '@bike4mind/common';
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
  await FabFile.deleteMany({}, { hardDelete: true });
});

const makeFile = (fileName: string, overrides: Record<string, unknown> = {}) =>
  FabFile.create({ fileName, userId: 'owner', type: KnowledgeType.URL, mimeType: 'text/plain', ...overrides });

describe('FabFileRepository.findPageByIds', () => {
  it('pages the given ids ascending by _id without gaps or repeats', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) files.push(await makeFile(`f${i}.txt`));
    const outsider = await makeFile('outsider.txt');
    const ids = files.map(f => String(f.id)).reverse();

    const first = await fabFileRepository.findPageByIds(ids, { limit: 2 });
    expect(first.data.map(f => f.fileName)).toEqual(['f0.txt', 'f1.txt']);
    expect(first.hasMore).toBe(true);

    const second = await fabFileRepository.findPageByIds(ids, { limit: 2, afterId: String(first.data[1].id) });
    expect(second.data.map(f => f.fileName)).toEqual(['f2.txt', 'f3.txt']);
    expect(second.hasMore).toBe(true);

    const last = await fabFileRepository.findPageByIds(ids, { limit: 2, afterId: String(second.data[1].id) });
    expect(last.data.map(f => f.fileName)).toEqual(['f4.txt']);
    expect(last.hasMore).toBe(false);
    expect(ids).not.toContain(String(outsider.id));
  });

  it('skips soft-deleted rows and ids that cannot address a row', async () => {
    const live = await makeFile('live.txt');
    const deleted = await makeFile('deleted.txt', { deletedAt: new Date() });

    const page = await fabFileRepository.findPageByIds([String(live.id), String(deleted.id), 'legacy-not-an-id'], {
      limit: 10,
    });
    expect(page.data.map(f => f.fileName)).toEqual(['live.txt']);
    expect(page.hasMore).toBe(false);
  });

  it('selects only the summary fields', async () => {
    const file = await makeFile('a.txt', { filePath: 'secret/path', notes: 'private', fileSize: 12 });
    const [row] = (await fabFileRepository.findPageByIds([String(file.id)], { limit: 1 })).data;
    expect(row).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain', fileSize: 12 });
    expect(row).not.toHaveProperty('filePath');
    expect(row).not.toHaveProperty('notes');
  });

  it('returns an empty page for a cursor that is not an ObjectId', async () => {
    const file = await makeFile('a.txt');
    expect(await fabFileRepository.findPageByIds([String(file.id)], { limit: 1, afterId: 'nope' })).toEqual({
      data: [],
      hasMore: false,
    });
  });
});
