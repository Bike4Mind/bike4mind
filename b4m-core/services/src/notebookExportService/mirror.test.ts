import { describe, it, expect, vi } from 'vitest';
import { NotebookExportService } from './index';
import type { NotebookExportAdapters } from './index';
import {
  MIRROR_GENESIS_CURSOR,
  applyMirrorPage,
  decodeMirrorCursor,
  encodeMirrorCursor,
  mirrorStateToBundle,
} from './mirror';
import type { MirrorState } from './mirror';

type Row = { id: string; name: string; firstCreated: Date; lastUpdated: Date };
type Query = { userId?: string; $or?: [{ lastUpdated: { $gt: Date } }, { lastUpdated: Date; _id: { $gt: string } }] };

const OPTIONS = {
  includeKnowledge: false,
  includeArtifacts: false,
  includeTools: false,
  includeAgents: false,
  includeImages: false,
  includeMetadata: true,
  maxFileSize: 1_000_000,
} as unknown as Parameters<NotebookExportService['exportNotebooks']>[1];

const row = (id: string, day: number, name = id): Row => ({
  id,
  name,
  firstCreated: new Date('2026-01-01T00:00:00Z'),
  lastUpdated: new Date(Date.UTC(2026, 0, day)),
});

function makeService(rows: Row[]) {
  const sessionRepository = {
    find: vi.fn(async (query: Query, options?: { limit?: number }) => {
      const [byTime, byTie] = query.$or ?? [];
      const sorted = [...rows].sort(
        (a, b) => a.lastUpdated.getTime() - b.lastUpdated.getTime() || a.id.localeCompare(b.id)
      );
      const matching = sorted.filter(r =>
        !query.$or
          ? true
          : r.lastUpdated > byTime.lastUpdated.$gt ||
            (r.lastUpdated.getTime() === (byTie as { lastUpdated: Date }).lastUpdated.getTime() &&
              r.id > (byTie as { _id: { $gt: string } })._id.$gt)
      );
      return options?.limit ? matching.slice(0, options.limit) : matching;
    }),
  };
  const empty = { find: vi.fn().mockResolvedValue([]) };
  const adapters = {
    sessionRepository,
    chatHistoryRepository: empty,
    knowledgeRepository: { ...empty, findAccessibleInIds: vi.fn().mockResolvedValue([]) },
    artifactRepository: empty,
    artifactContentRepository: empty,
    toolRepository: empty,
    agentRepository: empty,
    fileStorageService: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as NotebookExportAdapters;
  return new NotebookExportService(adapters);
}

const tokenOf = encodeMirrorCursor;

async function sync(service: NotebookExportService, state: MirrorState, cursorToken?: string, limit = 2) {
  let cursor = decodeMirrorCursor(cursorToken);
  let hasMore = true;
  while (hasMore) {
    const page = await service.getMirrorPage(
      'user-1',
      OPTIONS,
      cursor === MIRROR_GENESIS_CURSOR ? undefined : tokenOf(cursor),
      limit
    );
    cursor = applyMirrorPage(state, cursor, page);
    hasMore = page.hasMore;
  }
  return cursor;
}

async function bundleBytes(state: MirrorState) {
  const files = new Map<string, string>();
  await mirrorStateToBundle(state, async (p, b) => void files.set(p, Buffer.from(b).toString('utf8')), {
    exportedAt: '2026-02-01T00:00:00.000Z',
  });
  return Object.fromEntries(files);
}

describe('mirror feed', () => {
  it('bootstrap plus incremental changes equals a fresh full export', async () => {
    const rows = [row('a', 1), row('b', 2), row('c', 2), row('d', 3)];
    const service = makeService(rows);

    const mirrored: MirrorState = new Map();
    const cursor = await sync(service, mirrored);

    rows[1] = row('b', 5, 'b renamed');
    rows.push(row('e', 6));
    rows.splice(0, 1);
    await sync(service, mirrored, tokenOf(cursor));

    const fresh: MirrorState = new Map();
    await sync(makeService(rows), fresh, undefined, 100);

    expect(await bundleBytes(mirrored)).toEqual(await bundleBytes(fresh));
    expect([...mirrored.keys()].sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('rejects a page whose snapshot was altered', async () => {
    const page = await makeService([row('a', 1)]).getMirrorPage('user-1', OPTIONS, undefined, 10);
    page.entries[0].notebook.name = 'tampered';
    expect(() => applyMirrorPage(new Map(), MIRROR_GENESIS_CURSOR, page)).toThrow(/hash mismatch/);
  });

  it('rejects a page that skips a link in the chain', async () => {
    const service = makeService([row('a', 1), row('b', 2), row('c', 3)]);
    const first = await service.getMirrorPage('user-1', OPTIONS, undefined, 1);
    const second = await service.getMirrorPage('user-1', OPTIONS, first.cursor, 1);
    expect(() => applyMirrorPage(new Map(), MIRROR_GENESIS_CURSOR, second)).toThrow(/chain broken/);
  });

  it('rejects a malformed cursor', () => {
    expect(() => decodeMirrorCursor('not-a-cursor')).toThrow('Invalid mirror cursor');
  });
});
