// @vitest-environment node
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  readCallableFunctionSource,
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
  upload: vi.fn(async (body: Buffer, key: string) => void objects.set(key, body)),
  download: vi.fn(async (key: string) => objects.get(key) ?? Promise.reject(new Error('NoSuchKey'))),
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

describe('readCallableFunctionSource', () => {
  it("gives the owner's browser the bytes and the same stamp entry a server call writes", async () => {
    const pins = [{ name: 'base.csv', sha256: sha('frozen'), bytes: 6, fetchedAt: new Date(0) }];
    objects.set(`data/${FN_ID}/${sha('frozen')}`, Buffer.from('frozen'));
    withFunction([{ name: 'base.csv', url: `${ORIGIN}/base.csv`, mode: 'pinned' }, live()], pins);
    const server = await resolveCallableFunctionSources(h.fn as never, deps);
    for (const read of server) {
      const browser = await readCallableFunctionSource(OWNER, FN_ID, read.entry.name, deps);
      expect(Object.keys(browser.entry).sort()).toEqual(Object.keys(read.entry).sort());
      expect(browser.entry).toEqual(read.entry);
      expect(sha(browser.bytes.toString())).toBe(read.entry.sha256);
    }
  });

  it('is not found for another owner and for a name that is not a source', async () => {
    h.fn = null;
    await expect(readCallableFunctionSource(OWNER, FN_ID, 'rates.csv', deps)).rejects.toThrow('Tool not found');
    withFunction([live()]);
    await expect(readCallableFunctionSource(OWNER, FN_ID, 'other.csv', deps)).rejects.toThrow('Source not found');
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
    expect(objects.get(`data/${FN_ID}/${sha('x,y\n1,3\n')}`)?.toString()).toBe('x,y\n1,3\n');
  });
});
