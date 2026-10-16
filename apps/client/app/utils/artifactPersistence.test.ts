import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  type: string;
  sessionId?: string;
  identifier?: string;
  content: string;
  version: number;
  createdAt: number;
  metadata: Record<string, unknown>;
}

interface Body {
  id: string;
  type: string;
  sessionId?: string;
  identifier?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// An in-memory /api/artifacts. Every call yields a tick first, so artifacts persisted in parallel
// interleave their lookups and writes the way real requests do.
const store = { rows: [] as Row[], clock: 0 };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const get = vi.fn(async (_url: string, config?: { params?: Record<string, unknown> }) => {
  await tick();
  const params = config?.params ?? {};
  const rows = store.rows
    .filter(row => row.sessionId === params.sessionId && row.type === params.type)
    // Mirrors the identifier filter in b4m-core/services/src/artifactService/list.ts.
    .filter(
      row =>
        params.identifier === undefined ||
        row.identifier === params.identifier ||
        (row.identifier === undefined && row.metadata.originalIdentifier === params.identifier)
    )
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Number(params.limit));
  return { status: 200, data: { artifacts: rows.map(row => ({ ...row })) } };
});

const post = vi.fn(async (_url: string, body: Body) => {
  await tick();
  store.rows.push({
    id: body.id,
    type: body.type,
    sessionId: body.sessionId,
    identifier: body.identifier,
    content: body.content,
    version: 1,
    createdAt: ++store.clock,
    metadata: body.metadata ?? {},
  });
  return { status: 201, data: {} };
});

const put = vi.fn(async (url: string, body: { content: string; metadata: Record<string, unknown> }) => {
  await tick();
  const row = store.rows.find(r => url === `/api/artifacts/${r.id}`);
  if (!row) throw new Error(`no row for ${url}`);
  row.version += 1;
  row.content = body.content;
  row.metadata = { ...row.metadata, ...body.metadata };
  return { status: 200, data: {} };
});

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: {
    get: (...args: Parameters<typeof get>) => get(...args),
    post: (...args: Parameters<typeof post>) => post(...args),
    put: (...args: Parameters<typeof put>) => put(...args),
  },
}));

import { findExistingArtifactId, persistArtifacts } from './artifactPersistence';

const SESSION = 's1';

let reply = 0;
/** One parsed block as the streaming hook hands it over; ids are unique per reply and index. */
const block = (type: string, identifier: string | undefined, content: string, index = 0) => ({
  id: `artifact_${type}_${identifier ?? 'generated'}_${reply}_${index}`,
  type,
  title: content,
  content,
  identifier,
  metadata: { questId: `q${reply}`, originalIdentifier: identifier },
});

const seed = (row: Partial<Row> & { id: string; type: string }) =>
  store.rows.push({ sessionId: SESSION, content: '', version: 1, createdAt: ++store.clock, metadata: {}, ...row });

const rowsByIdentifier = () => store.rows.map(({ identifier, version }) => ({ identifier, version }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store.rows = [];
  store.clock = 0;
  reply += 1;
});

describe('persistArtifacts - React versioning', () => {
  it('creates a v1 row per identifier, leaving an earlier unrelated React artifact alone', async () => {
    seed({ id: 'artifact_react_old_0_0', type: 'react', identifier: 'old' });

    await persistArtifacts([block('react', 'todo', 'T1', 1), block('react', 'chart', 'C1', 0)], SESSION);

    expect(post).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
    expect(rowsByIdentifier()).toEqual([
      { identifier: 'old', version: 1 },
      { identifier: 'todo', version: 1 },
      { identifier: 'chart', version: 1 },
    ]);
    expect(post).toHaveBeenCalledWith('/api/artifacts', expect.objectContaining({ identifier: 'todo' }));
  });

  it('versions only the matching row when a later reply re-emits an identifier', async () => {
    await persistArtifacts([block('react', 'todo', 'T1', 1), block('react', 'chart', 'C1', 0)], SESSION);
    const todoId = store.rows.find(r => r.identifier === 'todo')!.id;
    vi.clearAllMocks();
    reply += 1;

    await persistArtifacts([block('react', 'todo', 'T2')], SESSION);

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      `/api/artifacts/${todoId}`,
      expect.objectContaining({ content: 'T2', createNewVersion: true })
    );
    expect(rowsByIdentifier()).toEqual([
      { identifier: 'todo', version: 2 },
      { identifier: 'chart', version: 1 },
    ]);
    expect(store.rows[0].metadata.originalIdentifier).toBe('todo');
  });

  it('persists a repeated identifier within one reply in order, as v1 then v2 of one row', async () => {
    await persistArtifacts([block('react', 'app', 'first', 1), block('react', 'app', 'second', 0)], SESSION);

    expect(post).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({ id: block('react', 'app', 'first', 1).id, version: 2, content: 'second' });
  });

  it('still creates the row when the earlier block of the same identifier failed', async () => {
    post.mockRejectedValueOnce(new Error('network'));

    await persistArtifacts([block('react', 'app', 'first', 1), block('react', 'app', 'second', 0)], SESSION);

    expect(post).toHaveBeenCalledTimes(2);
    expect(put).not.toHaveBeenCalled();
    expect(store.rows).toEqual([expect.objectContaining({ content: 'second', version: 1 })]);
  });

  it('creates a new row for a React artifact without an identifier', async () => {
    seed({ id: 'artifact_react_old_0_0', type: 'react', identifier: 'old' });

    await persistArtifacts([block('react', undefined, 'anon')], SESSION);

    expect(put).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][1]).not.toHaveProperty('identifier');
  });

  it('versions a legacy row that recorded the identifier only in metadata', async () => {
    seed({ id: 'artifact_react_todo_0_0', type: 'react', metadata: { originalIdentifier: 'todo' } });

    await persistArtifacts([block('react', 'todo', 'T2')], SESSION);

    expect(post).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledWith('/api/artifacts/artifact_react_todo_0_0', expect.anything());
  });

  it('keeps creating a new row per block for non-React types', async () => {
    seed({ id: 'artifact_html_page_0_0', type: 'html', identifier: 'page' });

    await persistArtifacts([block('html', 'page', 'P1', 1), block('html', 'page', 'P2', 0)], SESSION);

    expect(put).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(store.rows.filter(r => r.identifier === 'page')).toHaveLength(3);
  });
});

describe('findExistingArtifactId', () => {
  it('matches the identifier field, including identifiers that contain underscores', async () => {
    seed({ id: 'artifact_react_my_app_5_0', type: 'react', identifier: 'my_app' });

    expect(await findExistingArtifactId('react', 'my_app', SESSION)).toBe('artifact_react_my_app_5_0');
  });

  it('resolves a legacy row through metadata.originalIdentifier', async () => {
    seed({ id: 'artifact_react_todo_0_0', type: 'react', metadata: { originalIdentifier: 'todo' } });

    expect(await findExistingArtifactId('react', 'todo', SESSION)).toBe('artifact_react_todo_0_0');
  });

  it('falls back to the id segment for a legacy row with neither', async () => {
    seed({ id: 'artifact_html_page_0_0', type: 'html' });

    expect(await findExistingArtifactId('html', 'page', SESSION)).toBe('artifact_html_page_0_0');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('does not query for an empty identifier', async () => {
    seed({ id: 'artifact_react_old_0_0', type: 'react', identifier: 'old' });

    expect(await findExistingArtifactId('react', '', SESSION)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
