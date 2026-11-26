// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICallableFunctionSource, ICallableFunctionSourcePin } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  fn: null as null | Record<string, unknown>,
  setSources: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => []) },
  artifactRepository: { findOne: vi.fn(async () => ({ version: 1, deletedAt: null })) },
  callableFunctionRepository: {
    findByIdForOwner: vi.fn(async () => h.fn),
    setSources: h.setSources,
  },
}));

import {
  fetchPinnedCallableFunctionSources,
  linkCallableFunctionSourceForBrowser,
  readCallableFunctionSourceBytes,
  resolveCallableFunctionSources,
  setCallableFunctionSources,
} from './sources';
import type { CallableFunctionDataStorage } from './dataPins';
import { fetchCallableFunctionSource, type CallableFunctionSourceFetchRequest } from './fetchSource';

const FN_ID = 'a'.repeat(24);
const OWNER = { id: 'b'.repeat(24) };
const ORIGIN = 'https://data.example.com';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

let originData = 'x,y\n1,2\n';
const fetcher = vi.fn(async () => ({
  body: Buffer.from(originData),
  sha256: sha(originData),
  bytes: Buffer.byteLength(originData),
  fetchedAt: '2026-11-24T00:00:00.000Z',
}));
const objects = new Map<string, Buffer>();
const storage = {
  uploadStream: vi.fn(async (body: Readable, key: string, bytes: number) => {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
    const stored = Buffer.concat(chunks);
    if (stored.length !== bytes) throw new Error('length mismatch');
    objects.set(key, stored);
    return key;
  }),
  download: vi.fn(async (key: string) => objects.get(key) ?? Promise.reject(new Error('NoSuchKey'))),
  browserSigningOrigin: vi.fn(async () => 'https://data.example.com'),
  getSignedUrl: vi.fn(async (key: string) => `https://data.example.com/${key}?signed`),
} as unknown as CallableFunctionDataStorage;
const deps = { fetcher, storage, origins: [ORIGIN], limits: { fileBytes: 1024, totalBytes: 4096 } };

const withFunction = (sources: ICallableFunctionSource[], sourcePins?: ICallableFunctionSourcePin[]) => {
  h.fn = {
    id: FN_ID,
    userId: OWNER.id,
    updatedAt: new Date(1),
    sources,
    pin: { artifactId: 'art1', version: 1, dataPins: [{ name: 'taken.csv' }], ...(sourcePins ? { sourcePins } : {}) },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  objects.clear();
  originData = 'x,y\n1,2\n';
  withFunction([]);
  h.setSources.mockImplementation(async (_id, _owner, _expected, sources: ICallableFunctionSource[]) => ({
    ...h.fn,
    slug: 'fn',
    description: '',
    state: 'draft',
    enabled: true,
    examples: [],
    sources,
    pin: { artifactId: 'art1', version: 1, contentHash: 'c'.repeat(64), pinnedAt: new Date(0), dataPins: [] },
  }));
});

const live = (name = 'rates.csv', url = `${ORIGIN}/rates.csv`): ICallableFunctionSource => ({
  name,
  url,
  mode: 'live',
});

describe('setCallableFunctionSources', () => {
  it('saves sources on a listed origin and returns them in the view', async () => {
    const view = await setCallableFunctionSources(OWNER, FN_ID, [live()], deps);
    expect(view.sources).toEqual([live()]);
    expect(h.setSources).toHaveBeenCalledWith(FN_ID, { ownerType: 'user', ownerKey: OWNER.id }, h.fn, [live()]);
  });

  it('refuses an origin that is not listed, and saves nothing', async () => {
    await expect(
      setCallableFunctionSources(OWNER, FN_ID, [live('r.csv', 'https://other.example.net/r.csv')], deps)
    ).rejects.toMatchObject({
      additionalInfo: { code: 'source_origin_unlisted', origin: 'https://other.example.net' },
    });
    expect(h.setSources).not.toHaveBeenCalled();
  });

  it('refuses a name a data file holds, a plain http URL, and more than the data files leave room for', async () => {
    await expect(setCallableFunctionSources(OWNER, FN_ID, [live('taken.csv')], deps)).rejects.toMatchObject({
      additionalInfo: { code: 'data_name_taken' },
    });
    await expect(
      setCallableFunctionSources(OWNER, FN_ID, [live('r.csv', 'http://data.example.com/r.csv')], deps)
    ).rejects.toMatchObject({ additionalInfo: { code: 'source_url_invalid' } });
    const ten = Array.from({ length: 10 }, (_, i) => live(`s${i}.csv`));
    await expect(setCallableFunctionSources(OWNER, FN_ID, ten, deps)).rejects.toMatchObject({
      additionalInfo: { code: 'data_pin_limit' },
    });
    expect(h.setSources).not.toHaveBeenCalled();
  });

  it('counts each source at the most one fetch can return against the total, with the data files', async () => {
    const MIB = 1024 * 1024;
    const limits = { fileBytes: 100 * MIB, totalBytes: 10 * MIB };
    withFunction([]);
    (h.fn!.pin as { dataPins: unknown[] }).dataPins = [{ name: 'taken.csv', bytes: 2 * MIB }];
    await setCallableFunctionSources(OWNER, FN_ID, [live('a.csv'), live('b.csv')], { ...deps, limits });
    const three = [live('a.csv'), live('b.csv'), live('c.csv')];
    const refusal = setCallableFunctionSources(OWNER, FN_ID, three, { ...deps, limits });
    await expect(refusal).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/14 MB, over this tool's 10 MB total/),
      additionalInfo: { code: 'source_total_too_large', limit: 10 * MIB, needed: 14 * MIB },
    });
    expect(h.setSources).toHaveBeenCalledTimes(1);
  });

  it('saves a shorter list for a tool over a lowered total, and refuses one as long', async () => {
    const MIB = 1024 * 1024;
    const limits = { fileBytes: 4 * MIB, totalBytes: 2 * MIB };
    const three = [live('a.csv'), live('b.csv'), live('c.csv')];
    withFunction(three);
    (h.fn!.pin as { dataPins: unknown[] }).dataPins = [];
    await setCallableFunctionSources(OWNER, FN_ID, three.slice(0, 2), { ...deps, limits });
    expect(h.setSources).toHaveBeenCalledTimes(1);
    await expect(
      setCallableFunctionSources(OWNER, FN_ID, [...three.slice(0, 2), live('d.csv')], { ...deps, limits })
    ).rejects.toMatchObject({ additionalInfo: { code: 'source_total_too_large' } });
  });

  it('caps every fetch at the 4 MB a source holds of the total, above a larger file limit', async () => {
    withFunction([live()]);
    const limits = { fileBytes: 100 * 1024 * 1024, totalBytes: 1024 * 1024 * 1024 };
    await resolveCallableFunctionSources(h.fn as never, { ...deps, limits });
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ maxBodyBytes: 4 * 1024 * 1024 }));
  });
});

describe('pinned sources', () => {
  const pinned: ICallableFunctionSource = { name: 'base.csv', url: `${ORIGIN}/base.csv`, mode: 'pinned' };

  it('are fetched at promotion and stored by hash under the function prefix', async () => {
    withFunction([pinned, live()]);
    const pins = await fetchPinnedCallableFunctionSources(h.fn as never, deps);
    expect(pins).toEqual([{ name: 'base.csv', sha256: sha(originData), bytes: 8, fetchedAt: expect.any(Date) }]);
    expect(objects.get(`data/${FN_ID}/${sha(originData)}`)?.toString()).toBe(originData);
  });

  it('hold their hash after the origin data changes, while a live source follows it', async () => {
    withFunction([pinned, live()]);
    const pins = await fetchPinnedCallableFunctionSources(h.fn as never, deps);
    withFunction([pinned, live()], pins);
    originData = 'x,y\n9,9\n';
    const reads = await resolveCallableFunctionSources(h.fn as never, deps);
    expect(reads.map(read => read.entry)).toEqual([
      { name: 'base.csv', mode: 'pinned', sha256: sha('x,y\n1,2\n'), bytes: 8 },
      { name: 'rates.csv', mode: 'live', sha256: sha(originData), bytes: 8, fetched_at: '2026-11-24T00:00:00.000Z' },
    ]);
  });
});

describe('linkCallableFunctionSourceForBrowser', () => {
  const frozen = () => {
    objects.set(`data/${FN_ID}/${sha('frozen')}`, Buffer.from('frozen'));
    withFunction(
      [{ name: 'base.csv', url: `${ORIGIN}/base.csv`, mode: 'pinned' }, live()],
      [{ name: 'base.csv', sha256: sha('frozen'), bytes: 6, fetchedAt: new Date(0) }]
    );
  };

  it("gives the owner's browser the same stamp entry a server call writes and a one-minute link to its bytes", async () => {
    frozen();
    const server = await resolveCallableFunctionSources(h.fn as never, deps);
    for (const read of server) {
      const browser = await linkCallableFunctionSourceForBrowser(OWNER, FN_ID, read.entry.name, deps);
      expect(browser.entry).toEqual(read.entry);
      expect(browser.url).toBe(`https://data.example.com/${read.key}?signed`);
      expect(storage.getSignedUrl).toHaveBeenCalledWith(read.key, 'get', expect.objectContaining({ expiresIn: 60 }));
      expect(sha(objects.get(read.key)!.toString())).toBe(read.entry.sha256);
    }
  });

  it('stores a live fetch under the expiring prefix for the link, never beside the pinned copies', async () => {
    withFunction([live()]);
    const { entry } = await linkCallableFunctionSourceForBrowser(OWNER, FN_ID, 'rates.csv', deps);
    expect(objects.get(`data/.live/${FN_ID}/${entry.sha256}`)?.toString()).toBe(originData);
    expect(objects.has(`data/${FN_ID}/${entry.sha256}`)).toBe(false);
  });

  it('points at the read route where storage cannot sign a browser link, which serves the bytes it named', async () => {
    frozen();
    vi.mocked(storage.browserSigningOrigin).mockResolvedValueOnce('').mockResolvedValueOnce('');
    for (const name of ['base.csv', 'rates.csv']) {
      const { entry, url } = await linkCallableFunctionSourceForBrowser(OWNER, FN_ID, name, deps);
      expect(url).toBe(`/api/callable-functions/${FN_ID}/sources/${name}?bytes=1&sha256=${entry.sha256}`);
      const bytes = await readCallableFunctionSourceBytes(OWNER, FN_ID, name, entry.sha256, deps);
      expect(sha(bytes.toString())).toBe(entry.sha256);
    }
  });

  it('is not found for another owner, a name that is not a source, and a hash nothing stored', async () => {
    h.fn = null;
    await expect(linkCallableFunctionSourceForBrowser(OWNER, FN_ID, 'rates.csv', deps)).rejects.toThrow(
      'Tool not found'
    );
    withFunction([live()]);
    await expect(linkCallableFunctionSourceForBrowser(OWNER, FN_ID, 'other.csv', deps)).rejects.toThrow(
      'Source not found'
    );
    await expect(readCallableFunctionSourceBytes(OWNER, FN_ID, 'rates.csv', 'f'.repeat(64), deps)).rejects.toThrow(
      'Source not found'
    );
    await expect(readCallableFunctionSourceBytes(OWNER, FN_ID, 'rates.csv', '../x', deps)).rejects.toThrow(
      'Source not found'
    );
  });

  it('caps a fetch that spends a call at what is left of its time limit', async () => {
    withFunction([live()]);
    await resolveCallableFunctionSources(h.fn as never, deps, { timeoutMs: 2_000 });
    expect(fetcher).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 2_000 }));
  });
});

describe('through the guarded fetch, against an origin whose data changes', () => {
  let csv = 'x,y\n1,2\n';
  let server: Server;
  let origin = '';

  beforeAll(async () => {
    server = createServer((_req, res) => res.end(csv));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise(resolve => server.close(resolve)));

  it('gives a live source two hashes across a change, while the pinned hash holds', async () => {
    const real = {
      ...deps,
      origins: [origin],
      fetcher: (request: CallableFunctionSourceFetchRequest) =>
        fetchCallableFunctionSource(request, { allowLoopbackHttp: true }),
    };
    const sources: ICallableFunctionSource[] = [
      { name: 'base.csv', url: `${origin}/base.csv`, mode: 'pinned' },
      { name: 'rates.csv', url: `${origin}/rates.csv`, mode: 'live' },
    ];
    withFunction(sources);
    const pins = await fetchPinnedCallableFunctionSources(h.fn as never, real);
    withFunction(sources, pins);

    const first = await resolveCallableFunctionSources(h.fn as never, real);
    csv = 'x,y\n1,3\n';
    const second = await resolveCallableFunctionSources(h.fn as never, real);

    const entry = (reads: typeof first, name: string) => reads.find(read => read.entry.name === name)!.entry;
    expect(entry(first, 'rates.csv').sha256).toBe(sha('x,y\n1,2\n'));
    expect(entry(second, 'rates.csv').sha256).toBe(sha('x,y\n1,3\n'));
    expect(entry(second, 'base.csv')).toEqual({
      name: 'base.csv',
      mode: 'pinned',
      sha256: sha('x,y\n1,2\n'),
      bytes: 8,
    });
    expect(objects.get(`data/.live/${FN_ID}/${sha('x,y\n1,3\n')}`)?.toString()).toBe('x,y\n1,3\n');
    expect(objects.has(`data/${FN_ID}/${sha('x,y\n1,3\n')}`)).toBe(false);
  });
});
