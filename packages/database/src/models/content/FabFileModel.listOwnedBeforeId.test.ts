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

const OWNER = 'user-owner';
const OTHER = 'user-other';

const makeFile = (fileName: string, overrides: Record<string, unknown> = {}) =>
  FabFile.create({ fileName, userId: OWNER, type: KnowledgeType.URL, mimeType: 'text/plain', ...overrides });

async function collectAllPages(limit: number, search?: string) {
  const names: string[] = [];
  let beforeId: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await fabFileRepository.listOwnedBeforeId(OWNER, { beforeId, limit, search });
    names.push(...page.data.map(f => f.fileName));
    if (!page.hasMore) return names;
    beforeId = String(page.data.at(-1)!.id);
  }
  throw new Error('paging did not terminate');
}

describe('FabFileRepository.listOwnedBeforeId', () => {
  it('lists only live, unarchived files the user owns, newest first', async () => {
    await makeFile('a.txt');
    await makeFile('deleted.txt', { deletedAt: new Date() });
    await makeFile('archived.txt', { archivedAt: new Date() });
    await makeFile('theirs.txt', { userId: OTHER, users: [{ userId: OWNER, permissions: ['read'] }] });
    await makeFile('b.txt');

    expect(await collectAllPages(10)).toEqual(['b.txt', 'a.txt']);
  });

  it('pages across the whole set without gaps or repeats', async () => {
    for (let i = 0; i < 5; i++) await makeFile(`f${i}.txt`);

    const first = await fabFileRepository.listOwnedBeforeId(OWNER, { limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(await collectAllPages(2)).toEqual(['f4.txt', 'f3.txt', 'f2.txt', 'f1.txt', 'f0.txt']);
  });

  // An exact multiple of the page size: the last page must not claim another (a `>=` would).
  it('reports no further page when the last page is exactly full', async () => {
    for (let i = 0; i < 4; i++) await makeFile(`f${i}.txt`);

    const first = await fabFileRepository.listOwnedBeforeId(OWNER, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await fabFileRepository.listOwnedBeforeId(OWNER, {
      beforeId: String(first.data.at(-1)!.id),
      limit: 2,
    });
    expect(second.data.map(f => f.fileName)).toEqual(['f1.txt', 'f0.txt']);
    expect(second.hasMore).toBe(false);
  });

  it('matches a case-insensitive substring and treats regex metacharacters literally', async () => {
    await makeFile('Q3 Report.PDF');
    await makeFile('q3 report draft.pdf');
    await makeFile('notes (v1).txt');
    await makeFile('notes v1.txt');

    expect(await collectAllPages(10, 'q3 REPORT')).toEqual(['q3 report draft.pdf', 'Q3 Report.PDF']);
    expect(await collectAllPages(10, '(v1)')).toEqual(['notes (v1).txt']);
    expect(await collectAllPages(10, '.*')).toEqual([]);
  });

  it('pages a filtered result set', async () => {
    for (let i = 0; i < 3; i++) {
      await makeFile(`keep-${i}.txt`);
      await makeFile(`skip-${i}.txt`);
    }
    expect(await collectAllPages(1, 'KEEP')).toEqual(['keep-2.txt', 'keep-1.txt', 'keep-0.txt']);
  });

  it('selects only the summary fields', async () => {
    await makeFile('a.txt', { filePath: 'secret/path', notes: 'private', fileSize: 12 });
    const [file] = (await fabFileRepository.listOwnedBeforeId(OWNER, { limit: 1 })).data;
    expect(file).toMatchObject({ fileName: 'a.txt', mimeType: 'text/plain', fileSize: 12 });
    expect(file.createdAt).toBeInstanceOf(Date);
    expect(file).not.toHaveProperty('filePath');
    expect(file).not.toHaveProperty('notes');
  });

  it('rejects a cursor id that is not an ObjectId', async () => {
    await expect(fabFileRepository.listOwnedBeforeId(OWNER, { beforeId: 'nope', limit: 1 })).rejects.toThrow(
      /Invalid file cursor id/
    );
  });
});
