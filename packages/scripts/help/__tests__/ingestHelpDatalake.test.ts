import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HELP_DATALAKE_SLUG,
  HELP_DATALAKE_TAG,
  ingestHelpDatalake,
  type HelpDatalakeIngestDeps,
} from '../ingestHelpDatalake';
import type { HelpIndexEntry } from '../types';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const USER_ID = 'system-user';

function makeEntry(slug: string, accessLevel: 'public' | 'admin' = 'public'): HelpIndexEntry {
  return {
    slug,
    title: slug,
    description: '',
    category: 'features',
    sidebarPosition: 1,
    tags: [],
    headings: [],
    filePath: `${slug}.md`,
    accessLevel,
  };
}

/**
 * In-memory stand-in for the three repositories the mirror writes through. Records every call so a
 * test can assert on what did NOT happen (no delete, no embed) as well as what did.
 */
function makeHarness(lake: { id: string; status?: string } | null = { id: 'lake-1' }) {
  const files: {
    id: string;
    tags: { name: string; strength: number }[];
    contentHash?: string;
    embeddingModel?: string;
    vectorized?: boolean;
  }[] = [];
  const chunks: { fabFileId: string }[] = [];
  const lakeUpdates: Record<string, unknown>[] = [];
  const lakeCreates: Record<string, unknown>[] = [];
  const deletedFileIds: string[] = [];
  const embed = vi.fn(async () => [0.1, 0.2]);
  let nextId = 1;

  const deps: HelpDatalakeIngestDeps = {
    db: {
      fabFiles: {
        findIdsByDataLakeTag: vi.fn(async () => files.map(f => f.id)),
        findAllInIds: vi.fn(async (ids: string[]) => files.filter(f => ids.includes(f.id)) as never),
        deleteManyInIds: vi.fn(async (ids: string[]) => {
          deletedFileIds.push(...ids);
          for (const id of ids) {
            const i = files.findIndex(f => f.id === id);
            if (i >= 0) files.splice(i, 1);
          }
        }),
        create: vi.fn(async (data: Record<string, unknown>) => {
          const created = { ...data, id: `file-${nextId++}` };
          files.push(created as never);
          return created as never;
        }),
      } as never,
      fabFileChunks: {
        deleteManyByFabFileId: vi.fn(async (fabFileId: string) => {
          for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i].fabFileId === fabFileId) chunks.splice(i, 1);
        }),
        bulkInsert: vi.fn(async (payloads: { fabFileId: string }[]) => {
          chunks.push(...payloads);
        }),
      } as never,
      dataLakes: {
        findBySlug: vi.fn(async () => (lake ? ({ status: 'active', ...lake } as never) : null)),
        create: vi.fn(async (data: Record<string, unknown>) => {
          lakeCreates.push(data);
          return { ...data, id: 'lake-created' } as never;
        }),
        update: vi.fn(async (data: Record<string, unknown>) => {
          lakeUpdates.push(data);
          return null as never;
        }),
      } as never,
    },
    embed,
    embeddingModel: EMBEDDING_MODEL,
    logger: { info: () => {}, warn: () => {} },
  };

  return { deps, files, chunks, lakeUpdates, lakeCreates, deletedFileIds, embed };
}

describe('ingestHelpDatalake', () => {
  let root: string;

  const writeCorpus = (entries: HelpIndexEntry[], bodies: Record<string, string>) => {
    fs.writeFileSync(path.join(root, 'help-index.json'), JSON.stringify({ entries }));
    for (const [slug, body] of Object.entries(bodies)) {
      const file = path.join(root, 'docs', `${slug}.md`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
  };

  const opts = () => ({
    userId: USER_ID,
    helpIndexPath: path.join(root, 'help-index.json'),
    helpContentRoot: path.join(root, 'docs'),
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'help-lake-'));
    fs.mkdirSync(path.join(root, 'docs'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('mirrors only the public entries on a first run', async () => {
    writeCorpus([makeEntry('features/a'), makeEntry('admin/secret', 'admin')], {
      'features/a': '## One\n\nalpha\n',
      'admin/secret': '## Two\n\nclassified\n',
    });
    const h = makeHarness();

    const result = await ingestHelpDatalake(h.deps, opts());

    expect(result).toMatchObject({ publicEntries: 1, created: 1, unchanged: 0, removed: 0 });
    expect(h.files).toHaveLength(1);
    expect(h.files[0].tags.map(t => t.name)).toEqual([HELP_DATALAKE_TAG, 'help:features/a']);
  });

  it('re-runs as a no-op when nothing in the corpus moved', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();

    await ingestHelpDatalake(h.deps, opts());
    const embedCallsAfterFirstRun = h.embed.mock.calls.length;
    expect(embedCallsAfterFirstRun).toBeGreaterThan(0);

    const second = await ingestHelpDatalake(h.deps, opts());

    expect(second).toMatchObject({ unchanged: 1, created: 0, removed: 0 });
    // The point of the differential mirror: no re-embed, and no delete window on the live lake.
    expect(h.embed.mock.calls).toHaveLength(embedCallsAfterFirstRun);
    expect(h.deletedFileIds).toEqual([]);
  });

  it('re-embeds an article whose body changed, and leaves its untouched sibling alone', async () => {
    writeCorpus([makeEntry('features/a'), makeEntry('features/b')], {
      'features/a': '## One\n\nalpha\n',
      'features/b': '## Two\n\nbeta\n',
    });
    const h = makeHarness();
    await ingestHelpDatalake(h.deps, opts());
    const untouchedId = h.files.find(f => f.tags.some(t => t.name === 'help:features/b'))!.id;

    writeCorpus([makeEntry('features/a'), makeEntry('features/b')], { 'features/a': '## One\n\nrewritten\n' });
    const result = await ingestHelpDatalake(h.deps, opts());

    expect(result).toMatchObject({ unchanged: 1, created: 1, removed: 1 });
    expect(h.files.map(f => f.id)).toContain(untouchedId);
    expect(h.deletedFileIds).toHaveLength(1);
  });

  it('deletes a member whose slug left the corpus, so it stops being retrievable', async () => {
    writeCorpus([makeEntry('features/opti'), makeEntry('features/optihashi')], {
      'features/opti': '## Old\n\nconsolidated away\n',
      'features/optihashi': '## New\n\nthe survivor\n',
    });
    const h = makeHarness();
    await ingestHelpDatalake(h.deps, opts());
    expect(h.files).toHaveLength(2);

    writeCorpus([makeEntry('features/optihashi')], {});
    const result = await ingestHelpDatalake(h.deps, opts());

    expect(result).toMatchObject({ publicEntries: 1, removed: 1, unchanged: 1, created: 0 });
    expect(h.files.flatMap(f => f.tags.map(t => t.name))).not.toContain('help:features/opti');
    // The withdrawn article's chunks go too; a surviving chunk stays semantically searchable.
    expect(h.chunks.every(c => h.files.some(f => f.id === c.fabFileId))).toBe(true);
  });

  it('re-creates every member when the deployment embedding model changed', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();
    await ingestHelpDatalake(h.deps, opts());

    // Vectors from the old model are not comparable to the query vectors the KB search now
    // produces, so a matching content hash must NOT be enough to keep the member.
    const result = await ingestHelpDatalake({ ...h.deps, embeddingModel: 'text-embedding-3-large' }, opts());

    expect(result).toMatchObject({ unchanged: 0, created: 1, removed: 1 });
  });

  it('drops a duplicate member for the same slug, keeping one', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();
    await ingestHelpDatalake(h.deps, opts());
    // A pre-existing double-ingest: two members carry the same slug and the same body.
    h.files.push({ ...h.files[0], id: 'dupe' });

    const result = await ingestHelpDatalake(h.deps, opts());

    expect(result).toMatchObject({ unchanged: 1, removed: 1, created: 0 });
    expect(h.files.filter(f => f.tags.some(t => t.name === 'help:features/a'))).toHaveLength(1);
  });

  it('reports an indexed article whose markdown is absent rather than deleting its member', async () => {
    writeCorpus([makeEntry('features/a'), makeEntry('features/ghost')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();

    const result = await ingestHelpDatalake(h.deps, opts());

    expect(result.missingContent).toEqual(['features/ghost']);
    expect(result.created).toBe(1);
  });

  it('bounds embedding work per run and defers the remainder', async () => {
    const slugs = ['features/a', 'features/b', 'features/c'];
    writeCorpus(
      slugs.map(s => makeEntry(s)),
      Object.fromEntries(slugs.map(s => [s, `## H\n\n${s}\n`]))
    );
    const h = makeHarness();

    const first = await ingestHelpDatalake(h.deps, { ...opts(), maxCreatesPerRun: 2 });
    expect(first).toMatchObject({ created: 2, deferred: 1 });

    const second = await ingestHelpDatalake(h.deps, { ...opts(), maxCreatesPerRun: 2 });
    expect(second).toMatchObject({ created: 1, deferred: 0, unchanged: 2, removed: 0 });
  });

  it('stamps lastSyncAt so a lake that has not re-synced is distinguishable from one that has', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();

    await ingestHelpDatalake(h.deps, opts());

    expect(h.lakeUpdates.at(-1)).toMatchObject({ id: 'lake-1' });
    expect(h.lakeUpdates.at(-1)!.lastSyncAt).toBeInstanceOf(Date);
  });

  it('creates the lake when it is absent, so the bootstrap run has one to mirror into', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness(null);

    await ingestHelpDatalake(h.deps, opts());

    expect(h.lakeCreates[0]).toMatchObject({
      slug: HELP_DATALAKE_SLUG,
      datalakeTag: HELP_DATALAKE_TAG,
      fileTagPrefix: 'help:',
      createdByUserId: USER_ID,
      status: 'active',
    });
  });

  it('writes nothing on a dry run', async () => {
    writeCorpus([makeEntry('features/a')], { 'features/a': '## One\n\nalpha\n' });
    const h = makeHarness();

    const result = await ingestHelpDatalake(h.deps, { ...opts(), dryRun: true });

    expect(result.created).toBe(1);
    expect(h.files).toEqual([]);
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.lakeUpdates).toEqual([]);
  });
});
