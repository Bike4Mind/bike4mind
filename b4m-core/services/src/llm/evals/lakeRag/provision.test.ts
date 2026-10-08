import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLakeRagCorpus } from './corpus';
import { provisionLakeRagLakes, type CorpusDoc, type LakeRagApi } from './provision';

const AUTH = 'Bearer b4m_live_secret-token';

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };

/**
 * A fake deployment. `moderation` / `ingestion` script the statuses each file reports on
 * successive GETs (keyed by upload order); the last entry repeats.
 */
function fakeServer(
  opts: {
    moderation?: (string | null)[];
    ingestion?: Record<number, string[]>;
    lakeTag?: boolean;
    failDelete?: RegExp;
    storageStatus?: number;
    promote?: { status: number; lakeStatus?: string | null };
  } = {}
) {
  const calls: Call[] = [];
  const fileNames: string[] = [];
  const reads = new Map<string, number>();
  let clock = 0;
  const nextRead = (key: string) => {
    const n = reads.get(key) ?? 0;
    reads.set(key, n + 1);
    return n;
  };
  const pick = <T>(list: T[], n: number) => list[Math.min(n, list.length - 1)];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ method, url, headers: { ...(init.headers as Record<string, string>) }, body: init.body as string });
    const path = url.startsWith('https://storage.') ? '' : new URL(url).pathname;

    if (url.startsWith('https://storage.')) return new Response('', { status: opts.storageStatus ?? 200 });
    if (method === 'POST' && path === '/api/data-lakes') {
      const { slug } = JSON.parse(init.body as string) as { slug: string };
      return json(201, { id: `lake-${slug}`, ...(opts.lakeTag === false ? {} : { datalakeTag: `tag-${slug}` }) });
    }
    if (method === 'POST' && path === '/api/v1/files') {
      const { file_name } = JSON.parse(init.body as string) as { file_name: string };
      const id = `file${fileNames.length}`;
      fileNames.push(file_name);
      return json(201, { id, upload_url: `https://storage.example.com/${id}`, upload_url_expires_at: 'x' });
    }
    const fileGet = path.match(/^\/api\/v1\/files\/(file\d+)$/);
    if (method === 'GET' && fileGet) {
      return json(200, { id: fileGet[1], moderation_status: pick(opts.moderation ?? ['clean'], nextRead(path)) });
    }
    const member = path.match(/^\/api\/v1\/data-lakes\/([^/]+)\/files\/file(\d+)$/);
    if (member && method === 'POST') return json(200, { lake_id: member[1], file_id: `file${member[2]}` });
    if (member && method === 'GET') {
      const script = opts.ingestion?.[Number(member[2])] ?? ['ready'];
      return json(200, { ingestion_status: pick(script, nextRead(path)) });
    }
    const lifecycle = path.match(/^\/api\/data-lakes\/([^/]+)\/lifecycle$/);
    if (method === 'POST' && lifecycle) {
      const { status, lakeStatus } = opts.promote ?? { status: 200 };
      return json(
        status,
        status === 200
          ? { id: lifecycle[1], status: lakeStatus === undefined ? 'active' : lakeStatus }
          : { error: 'nope' }
      );
    }
    if (method === 'DELETE') {
      if (opts.failDelete?.test(path)) return json(500, { error: 'boom' });
      return json(200, {});
    }
    return json(404, { error: `unrouted ${method} ${path}` });
  }) as typeof fetch;

  const api: LakeRagApi = {
    baseUrl: 'https://app.example.com',
    authorization: AUTH,
    fetch: fetchImpl,
    pollIntervalMs: 1_000,
    pollTimeoutMs: 10_000,
    notIngestedGraceMs: 3_000,
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
  };
  return { api, calls, fileNames };
}

const doc = (fileName: string, generation: CorpusDoc['generation'], subject = 'moons'): CorpusDoc => ({
  subject,
  fileName,
  generation,
  body: `# ${fileName} ${generation}`,
});

const paths = (calls: Call[]) => calls.map(c => `${c.method} ${c.url.replace('https://app.example.com', '')}`);

describe('provisionLakeRagLakes', () => {
  it('registers and ingests the stale same-name file before the current one is even created', async () => {
    const { api, calls, fileNames } = fakeServer({ ingestion: { 0: ['indexing', 'ready'] } });
    // Current listed first on purpose: order must come from generation, not input order.
    const { lakes } = await provisionLakeRagLakes(api, [doc('moons.md', 'current'), doc('moons.md', 'superseded')], {
      runId: 'r1',
    });

    expect(fileNames).toEqual(['moons.md', 'moons.md']);
    expect(calls.filter(c => c.method === 'PUT').map(c => c.body)).toEqual([
      '# moons.md superseded',
      '# moons.md current',
    ]);
    const seq = paths(calls);
    const supersededReady = seq.lastIndexOf('GET /api/v1/data-lakes/lake-lakerag-eval-moons-r1/files/file0');
    const currentCreated = seq.indexOf('POST /api/v1/files', seq.indexOf('POST /api/v1/files') + 1);
    expect(supersededReady).toBeGreaterThan(-1);
    expect(currentCreated).toBeGreaterThan(supersededReady);
    expect(JSON.parse(calls[seq.indexOf('POST /api/v1/files')].body!)).toMatchObject({ mime_type: 'text/markdown' });
    expect(lakes.moons).toEqual({ id: 'lake-lakerag-eval-moons-r1', datalakeTag: 'tag-lakerag-eval-moons-r1' });
  });

  it('promotes each lake once, only after every one of its files is ready', async () => {
    const { api, calls } = fakeServer({ ingestion: { 1: ['indexing', 'ready'] } });
    await provisionLakeRagLakes(
      api,
      [doc('a.md', 'superseded'), doc('a.md', 'current'), doc('b.md', 'current', 'units')],
      { runId: 'r1' }
    );
    const seq = paths(calls);
    const promoteMoons = seq.indexOf('POST /api/data-lakes/lake-lakerag-eval-moons-r1/lifecycle');
    const promoteUnits = seq.indexOf('POST /api/data-lakes/lake-lakerag-eval-units-r1/lifecycle');
    expect(seq.filter(p => p.endsWith('/lifecycle'))).toHaveLength(2);
    expect(promoteMoons).toBeGreaterThan(
      seq.lastIndexOf('GET /api/v1/data-lakes/lake-lakerag-eval-moons-r1/files/file1')
    );
    expect(promoteUnits).toBeGreaterThan(
      seq.lastIndexOf('GET /api/v1/data-lakes/lake-lakerag-eval-units-r1/files/file2')
    );
    expect(JSON.parse(calls[promoteMoons].body!)).toEqual({ action: 'promote' });
  });

  it.each([
    ['rejected', { status: 400 }, /lifecycle -> 400/],
    ['left non-active', { status: 200, lakeStatus: 'archived' }, /promote lake moons: status archived/],
    ['answered without a status', { status: 200, lakeStatus: null }, /promote lake moons: status null/],
  ])('tears down when the promote is %s', async (_label, promote, error) => {
    const { api, calls } = fakeServer({ promote });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(error);
    expect(paths(calls).filter(p => p.startsWith('DELETE'))).toEqual([
      'DELETE /api/v1/data-lakes/lake-lakerag-eval-moons-r1/files/file0',
      'DELETE /api/data-lakes/lake-lakerag-eval-moons-r1',
    ]);
  });

  it('PUTs the bytes with the presigned content type and no Authorization header', async () => {
    const { api, calls } = fakeServer();
    await provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' });
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.headers).toEqual({ 'Content-Type': 'text/markdown' });
    expect(calls.filter(c => c.method !== 'PUT').every(c => c.headers.Authorization === AUTH)).toBe(true);
  });

  it('polls moderation through pending and scanning, and treats null as clean', async () => {
    const { api, calls } = fakeServer({ moderation: ['pending', 'scanning', null] });
    await provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' });
    expect(calls.filter(c => c.url.endsWith('/api/v1/files/file0'))).toHaveLength(3);
  });

  it('throws on a blocked file and tears down the lake', async () => {
    const { api, calls } = fakeServer({ moderation: ['blocked'] });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(
      /moderation_status blocked/
    );
    expect(paths(calls)).toContain('DELETE /api/data-lakes/lake-lakerag-eval-moons-r1');
  });

  it('keeps polling not_ingested inside the grace window', async () => {
    const { api } = fakeServer({ ingestion: { 0: ['not_ingested', 'indexing', 'ready'] } });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).resolves.toBeDefined();
  });

  it('fails not_ingested past the grace window and tears down the attachment and lake', async () => {
    const { api, calls } = fakeServer({ ingestion: { 0: ['not_ingested'] } });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(
      /a\.md: ingestion_status not_ingested/
    );
    expect(paths(calls).filter(p => p.startsWith('DELETE'))).toEqual([
      'DELETE /api/v1/data-lakes/lake-lakerag-eval-moons-r1/files/file0',
      'DELETE /api/data-lakes/lake-lakerag-eval-moons-r1',
    ]);
  });

  it.each(['failed', 'paused'])('fails %s at once', async status => {
    const { api, calls } = fakeServer({ ingestion: { 0: [status] } });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(status);
    expect(calls.filter(c => c.method === 'GET' && c.url.includes('/data-lakes/'))).toHaveLength(1);
  });

  it('times out naming the file and its last status', async () => {
    const { api } = fakeServer({ ingestion: { 0: ['indexing'] } });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(
      'moons/current/a.md ingestion: still indexing after 10000ms'
    );
  });

  it('teardown keeps going past a failing DELETE and returns the failures', async () => {
    const { api, calls } = fakeServer({ failDelete: /\/files\// });
    const run = await provisionLakeRagLakes(api, [doc('a.md', 'current'), doc('b.md', 'current', 'units')], {
      runId: 'r1',
    });
    const errors = await run.teardown();
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).not.toContain('secret-token');
    expect(paths(calls).filter(p => p.startsWith('DELETE /api/data-lakes/'))).toHaveLength(2);
  });

  it('fails a rejected storage PUT by name and tears the lake down', async () => {
    const { api, calls } = fakeServer({ storageStatus: 403 });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(
      /upload PUT -> 403/
    );
    expect(paths(calls)).toContain('DELETE /api/data-lakes/lake-lakerag-eval-moons-r1');
  });

  it('rethrows the original error unchanged when teardown is clean', async () => {
    const { api } = fakeServer({ storageStatus: 403 });
    const err = await provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AggregateError);
  });

  it('surfaces what teardown could not delete alongside the original error', async () => {
    const { api } = fakeServer({ storageStatus: 403, failDelete: /^\/api\/data-lakes\// });
    const err = await provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AggregateError);
    const { message, errors } = err as AggregateError;
    expect(message).toMatch(/upload PUT -> 403; teardown left 1 lake\(s\)/);
    expect(errors).toHaveLength(2);
    expect(String(errors[0])).toMatch(/upload PUT -> 403/);
    expect(String(errors[1])).toMatch(/DELETE \/api\/data-lakes\/.* -> 500/);
  });

  it('throws when the created lake carries no datalakeTag', async () => {
    const { api } = fakeServer({ lakeTag: false });
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'r1' })).rejects.toThrow(
      /no datalakeTag/
    );
  });

  it('rejects an empty corpus and a runId that would break the slug or tag prefix', async () => {
    const { api } = fakeServer();
    await expect(provisionLakeRagLakes(api, [], { runId: 'r1' })).rejects.toThrow(/no corpus/);
    await expect(provisionLakeRagLakes(api, [doc('a.md', 'current')], { runId: 'Bad_Id' })).rejects.toThrow(/runId/);
  });
});

describe('readLakeRagCorpus', () => {
  it('reads every subject with superseded generations under their bare file name', () => {
    const docs = readLakeRagCorpus(join(__dirname, 'corpus'));
    expect(new Set(docs.map(d => d.subject))).toEqual(new Set(['planetary-moons', 'si-units', 'us-census']));
    const stale = docs.filter(d => d.generation === 'superseded');
    expect(stale.length).toBeGreaterThan(0);
    for (const s of stale) {
      expect(s.fileName).not.toContain('/');
      expect(docs.some(d => d.generation === 'current' && d.subject === s.subject && d.fileName === s.fileName)).toBe(
        true
      );
    }
  });
});
