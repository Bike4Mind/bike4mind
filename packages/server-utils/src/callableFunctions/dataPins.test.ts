import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICallableFunctionDataPin, IUserDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  fn: null as null | Record<string, unknown>,
  setDataPins: vi.fn(),
  listForOwner: vi.fn(),
  access: vi.fn(),
  sourceDownload: vi.fn(),
  sourceHead: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => []) },
  artifactRepository: { findOne: vi.fn(async () => ({ version: 1, deletedAt: null })) },
  fabFileRepository: {},
  callableFunctionRepository: {
    findByIdForOwner: vi.fn(async (_id: string, owner: { ownerKey: string }) =>
      h.fn && owner.ownerKey === h.fn.userId ? h.fn : null
    ),
    setDataPins: h.setDataPins,
    listForOwner: h.listForOwner,
  },
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { assertFabFileAccessById: h.access },
  scopedSettingsService: {},
}));
vi.mock('../utils/storage/index', () => ({
  getFilesStorage: () => ({
    getMetadata: h.sourceHead,
    getContent: async () => Readable.from([await h.sourceDownload()]),
  }),
}));
vi.mock('@bike4mind/fab-pipeline', () => ({ S3Storage: class {} }));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn(), error: vi.fn() } }));

import {
  linkCallableFunctionDataForBrowser,
  pinCallableFunctionData,
  purgeCallableFunctionDataForUser,
  readCallableFunctionData,
  signCallableFunctionDataLinks,
  unpinCallableFunctionData,
  type CallableFunctionDataStorage,
} from './dataPins';

const FN_ID = 'a'.repeat(24);
const OWNER = { id: 'b'.repeat(24) } as IUserDocument;
const MIB = 1024 * 1024;
const LIMITS = { fileBytes: 100 * MIB, totalBytes: 1024 * MIB };
const CSV = Buffer.from('x,y\n1,2\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const pinOf = (name: string, bytes = 10, hash = sha(Buffer.from(name))): ICallableFunctionDataPin => ({
  name,
  sha256: hash,
  bytes,
  sourceFileId: 'file0',
  pinnedAt: new Date(0),
});

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage = {
    uploadStream: vi.fn(async (input: Readable, key: string) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input) chunks.push(chunk as Buffer);
      objects.set(key, Buffer.concat(chunks));
      return key;
    }),
    copy: vi.fn(async (source: string, key: string) => {
      objects.set(key, objects.get(source)!);
      return key;
    }),
    browserSigningOrigin: vi.fn(async () => 'https://data.example.com'),
    download: vi.fn(async (key: string) => {
      const found = objects.get(key);
      if (!found) throw new Error('NoSuchKey');
      return found;
    }),
    delete: vi.fn(async (key: string) => void objects.delete(key)),
    deletePrefix: vi.fn(async (prefix: string) => {
      const keys = [...objects.keys()].filter(key => key.startsWith(prefix));
      keys.forEach(key => objects.delete(key));
      return keys.length;
    }),
    getSignedUrl: vi.fn(
      async (key: string, _operation?: string, _options?: { expiresIn?: number }) =>
        `https://data.example.com/${key}?signed`
    ),
  };
  return { objects, storage: storage as unknown as CallableFunctionDataStorage & typeof storage };
}

const withPins = (dataPins: ICallableFunctionDataPin[]) => {
  h.fn = { id: FN_ID, userId: OWNER.id, updatedAt: new Date(1), pin: { artifactId: 'art1', version: 1, dataPins } };
  h.setDataPins.mockImplementation(async (_id, _owner, _expected, pins: ICallableFunctionDataPin[]) => ({
    ...(h.fn = { ...h.fn, pin: { ...(h.fn!.pin as object), dataPins: pins } }),
    slug: 'fn',
    description: '',
    state: 'draft',
    enabled: true,
    examples: [],
    pin: { ...(h.fn!.pin as object), contentHash: 'c'.repeat(64), pinnedAt: new Date(0), dataPins: pins },
  }));
};

beforeEach(() => {
  vi.clearAllMocks();
  withPins([]);
  h.access.mockResolvedValue({
    id: 'file1',
    userId: OWNER.id,
    filePath: 'files/u/points.csv',
    fileSize: CSV.length,
    moderationStatus: 'clean',
  });
  h.sourceDownload.mockResolvedValue(CSV);
  h.sourceHead.mockImplementation(async () => ({ size: CSV.length }));
});

describe('pinCallableFunctionData', () => {
  it("copies the file's bytes under the function's prefix by hash and records the pin", async () => {
    const { objects, storage } = memoryStorage();
    const input = { fileId: 'file1', name: 'points.csv' };
    const result = await pinCallableFunctionData(OWNER, FN_ID, input, { storage, limits: LIMITS });
    expect([...objects.keys()]).toEqual([`data/${FN_ID}/${sha(CSV)}`]);
    expect(result.dataPins).toEqual([expect.objectContaining({ name: 'points.csv', sha256: sha(CSV), bytes: 8 })]);
    expect(h.setDataPins.mock.calls[0]![3]).toEqual([expect.objectContaining({ sourceFileId: 'file1' })]);
  });

  it('refuses a file the owner cannot read', async () => {
    h.access.mockRejectedValue(Object.assign(new Error('File not found'), { statusCode: 404 }));
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'theirs', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  it.each([
    ['blocked', 404],
    ['pending', 409],
    [undefined, 409],
  ])('refuses a file whose moderation status is %s without reading it', async (moderationStatus, statusCode) => {
    h.access.mockResolvedValue({ id: 'file1', filePath: 'files/u/points.csv', fileSize: 8, moderationStatus });
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode });
    expect(h.sourceDownload).not.toHaveBeenCalled();
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  const UNSAFE_NAMES = ['../points.csv', '.hidden', 'a/b.csv', 'x'.repeat(65), 'has space.csv'];
  it.each(UNSAFE_NAMES)('refuses the name %j', async name => {
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_name_invalid' } });
    expect(h.access).not.toHaveBeenCalled();
  });

  it('refuses an eleventh file', async () => {
    withPins(Array.from({ length: 10 }, (_, i) => pinOf(`f${i}.csv`)));
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 409, additionalInfo: { code: 'data_pin_limit' } });
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  it('refuses a file over the per-file limit, by its recorded size before reading it', async () => {
    h.access.mockResolvedValue({
      id: 'file1',
      userId: OWNER.id,
      filePath: 'files/u/big.csv',
      fileSize: 100 * MIB + 1,
      moderationStatus: 'clean',
    });
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'big.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_file_too_large' } });
    expect(h.sourceDownload).not.toHaveBeenCalled();
  });

  it.each([
    ['lower', 1],
    ['missing', undefined],
  ])(
    "refuses a file over the per-file limit by the stored object's size when the recorded size is %s",
    async (_label, fileSize) => {
      h.access.mockResolvedValue({ id: 'file1', userId: OWNER.id, filePath: 'f', fileSize, moderationStatus: 'clean' });
      const { storage } = memoryStorage();
      await expect(
        pinCallableFunctionData(
          OWNER,
          FN_ID,
          { fileId: 'file1', name: 'points.csv' },
          { storage, limits: { fileBytes: 4, totalBytes: LIMITS.totalBytes } }
        )
      ).rejects.toMatchObject({ additionalInfo: { code: 'data_file_too_large' } });
      expect(h.sourceHead).toHaveBeenCalledWith('f');
      expect(h.sourceDownload).not.toHaveBeenCalled();
    }
  );

  it('refuses a stored object of unknown size without reading it', async () => {
    h.sourceHead.mockResolvedValue({ size: undefined });
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_file_empty' } });
    expect(h.sourceDownload).not.toHaveBeenCalled();
  });

  it('refuses a file that someone else uploaded, even one shared with the actor', async () => {
    h.access.mockResolvedValue({
      id: 'file1',
      userId: 'c'.repeat(24),
      filePath: 'f',
      fileSize: 8,
      moderationStatus: 'clean',
    });
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_file_not_owned' } });
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  it('streams the copy through a staging key that it always removes', async () => {
    const { objects, storage } = memoryStorage();
    await pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS });
    const staging = storage.uploadStream.mock.calls[0]![1];
    expect(staging).toMatch(new RegExp(`^data/${FN_ID}/staging/`));
    expect(storage.uploadStream.mock.calls[0]![2]).toBe(CSV.length);
    expect(storage.copy).toHaveBeenCalledWith(staging, `data/${FN_ID}/${sha(CSV)}`);
    expect(objects.has(staging)).toBe(false);
  });

  it('refuses bytes that run past the stored size and keeps no copy of them', async () => {
    h.sourceHead.mockResolvedValue({ size: 4 });
    const { objects, storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toThrow();
    expect(storage.copy).not.toHaveBeenCalled();
    expect(h.setDataPins).not.toHaveBeenCalled();
    expect(objects.size).toBe(0);
  });

  it('never deletes the content object when its write loses to another pin of the same bytes', async () => {
    const { objects, storage } = memoryStorage();
    h.setDataPins.mockResolvedValue(null);
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 409, additionalInfo: { code: 'version_changed' } });
    expect([...objects.keys()]).toEqual([`data/${FN_ID}/${sha(CSV)}`]);
    expect(storage.delete).not.toHaveBeenCalledWith(`data/${FN_ID}/${sha(CSV)}`);
  });

  it('refuses a file that would take the function over its total', async () => {
    withPins([pinOf('a.csv', 1024 * MIB - 4)]);
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_total_too_large' } });
    expect(storage.uploadStream).not.toHaveBeenCalled();
  });

  it('keeps reading the pinned copy after the source file is replaced', async () => {
    const { storage } = memoryStorage();
    await pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS });
    withPins(h.setDataPins.mock.calls[0]![3]);
    h.sourceDownload.mockResolvedValue(Buffer.from('x,y\n9,9\n'));
    const read = await readCallableFunctionData(OWNER, FN_ID, 'points.csv', { storage });
    expect(read.bytes).toEqual(CSV);
    expect(h.sourceDownload).toHaveBeenCalledTimes(1);
  });

  it('removes the copy on unpin unless another pin holds the same bytes', async () => {
    const { objects, storage } = memoryStorage();
    const shared = sha(CSV);
    objects.set(`data/${FN_ID}/${shared}`, CSV);
    withPins([pinOf('a.csv', 8, shared), pinOf('b.csv', 8, shared)]);
    await unpinCallableFunctionData(OWNER, FN_ID, 'a.csv', { storage });
    expect(objects.size).toBe(1);
    withPins([pinOf('b.csv', 8, shared)]);
    await unpinCallableFunctionData(OWNER, FN_ID, 'b.csv', { storage });
    expect(objects.size).toBe(0);
  });

  it('keeps the copy when a pin of the same bytes committed between the unpin and its delete', async () => {
    const { objects, storage } = memoryStorage();
    const shared = sha(CSV);
    objects.set(`data/${FN_ID}/${shared}`, CSV);
    withPins([pinOf('a.csv', 8, shared)]);
    h.setDataPins.mockImplementationOnce(async () => {
      const after = { ...h.fn, pin: { ...(h.fn!.pin as object), dataPins: [pinOf('b.csv', 8, shared)] } };
      h.fn = after;
      return { ...after, slug: 'fn', description: '', state: 'draft', enabled: true, examples: [] };
    });
    await unpinCallableFunctionData(OWNER, FN_ID, 'a.csv', { storage });
    expect(objects.size).toBe(1);
  });

  it('answers an unpin as done when the object delete fails afterwards', async () => {
    const { storage } = memoryStorage();
    storage.delete.mockRejectedValue(new Error('SlowDown'));
    withPins([pinOf('a.csv', 8, sha(CSV))]);
    const result = await unpinCallableFunctionData(OWNER, FN_ID, 'a.csv', { storage });
    expect(result.dataPins).toEqual([]);
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
});

describe('linkCallableFunctionDataForBrowser', () => {
  it("signs a one-minute browser link for the owner's pin and answers anyone else as if it did not exist", async () => {
    const { storage } = memoryStorage();
    withPins([pinOf('points.csv', CSV.length, sha(CSV))]);
    const link = await linkCallableFunctionDataForBrowser(OWNER, FN_ID, 'points.csv', { storage });
    expect(link).toEqual({
      name: 'points.csv',
      sha256: sha(CSV),
      bytes: CSV.length,
      url: `https://data.example.com/data/${FN_ID}/${sha(CSV)}?signed`,
    });
    expect(storage.getSignedUrl).toHaveBeenCalledWith(`data/${FN_ID}/${sha(CSV)}`, 'get', {
      audience: 'browser',
      expiresIn: 60,
      ResponseContentType: 'application/octet-stream',
      ResponseContentDisposition: 'attachment',
      ResponseCacheControl: 'private, no-store',
    });
    await expect(
      linkCallableFunctionDataForBrowser({ id: 'e'.repeat(24) }, FN_ID, 'points.csv', { storage })
    ).rejects.toThrow('Tool not found');
  });

  it('points at the same-origin byte route where storage cannot sign a browser link', async () => {
    const { storage } = memoryStorage();
    storage.browserSigningOrigin.mockResolvedValue('');
    withPins([pinOf('points.csv', CSV.length, sha(CSV))]);
    const link = await linkCallableFunctionDataForBrowser(OWNER, FN_ID, 'points.csv', { storage });
    expect(link.url).toBe(`/api/callable-functions/${FN_ID}/data/points.csv?bytes=1`);
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('readCallableFunctionData', () => {
  it("reads the owner's pinned bytes and answers anyone else as if the function did not exist", async () => {
    const { objects, storage } = memoryStorage();
    objects.set(`data/${FN_ID}/${sha(CSV)}`, CSV);
    withPins([pinOf('points.csv', CSV.length, sha(CSV))]);
    expect((await readCallableFunctionData(OWNER, FN_ID, 'points.csv', { storage })).bytes).toEqual(CSV);
    await expect(readCallableFunctionData({ id: 'e'.repeat(24) }, FN_ID, 'points.csv', { storage })).rejects.toThrow(
      'Tool not found'
    );
    expect(storage.download).toHaveBeenCalledTimes(1);
  });
});

describe('signCallableFunctionDataLinks', () => {
  it("signs short-lived links for exactly the function's own pins", async () => {
    const { storage } = memoryStorage();
    const pins = [pinOf('a.csv'), pinOf('b.csv')];
    const links = await signCallableFunctionDataLinks({ id: FN_ID, pin: { dataPins: pins } }, storage);
    expect(storage.getSignedUrl.mock.calls.map(call => call[0])).toEqual(
      pins.map(pin => `data/${FN_ID}/${pin.sha256}`)
    );
    expect(storage.getSignedUrl.mock.calls.every(call => call[1] === 'get' && call[2]?.expiresIn === 300)).toBe(true);
    expect(links.map(link => link.name)).toEqual(['a.csv', 'b.csv']);
  });

  it('signs nothing for a function without pins', async () => {
    const { storage } = memoryStorage();
    expect(await signCallableFunctionDataLinks({ id: FN_ID, pin: {} }, storage)).toEqual([]);
    expect(storage.getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('purgeCallableFunctionDataForUser', () => {
  it("deletes every function's prefix and the account's own, and nobody else's", async () => {
    const { objects, storage } = memoryStorage();
    objects.set(`data/${FN_ID}/${sha(CSV)}`, CSV);
    objects.set(`data/${'d'.repeat(24)}/${sha(CSV)}`, CSV);
    h.listForOwner.mockResolvedValue([{ id: FN_ID }]);
    await purgeCallableFunctionDataForUser(OWNER.id, storage);
    expect([...objects.keys()]).toEqual([`data/${'d'.repeat(24)}/${sha(CSV)}`]);
    expect(storage.deletePrefix.mock.calls.map(call => call[0])).toEqual([`data/${FN_ID}/`, `data/${OWNER.id}/`]);
  });
});
