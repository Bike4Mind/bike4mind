import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICallableFunctionDataPin, IUserDocument } from '@bike4mind/common';

const h = vi.hoisted(() => ({
  fn: null as null | Record<string, unknown>,
  setDataPins: vi.fn(),
  listForOwner: vi.fn(),
  access: vi.fn(),
  sourceDownload: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
  organizationRepository: { findMembershipOrgIds: vi.fn(async () => []) },
  artifactRepository: { findOne: vi.fn(async () => ({ version: 1, deletedAt: null })) },
  fabFileRepository: {},
  callableFunctionRepository: {
    findByIdForOwner: vi.fn(async () => h.fn),
    setDataPins: h.setDataPins,
    listForOwner: h.listForOwner,
  },
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { assertFabFileAccessById: h.access },
  scopedSettingsService: {},
}));
vi.mock('../utils/storage/index', () => ({ getFilesStorage: () => ({ download: h.sourceDownload }) }));
vi.mock('@bike4mind/fab-pipeline', () => ({ S3Storage: class {} }));

import {
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
    upload: vi.fn(async (input: string | Buffer, key: string) => {
      objects.set(key, Buffer.from(input));
      return key;
    }),
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
    ...h.fn,
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
  h.access.mockResolvedValue({ id: 'file1', filePath: 'files/u/points.csv', fileSize: CSV.length });
  h.sourceDownload.mockResolvedValue(CSV);
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
    expect(storage.upload).not.toHaveBeenCalled();
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
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('refuses a file over the per-file limit, by its recorded size before reading it', async () => {
    h.access.mockResolvedValue({ id: 'file1', filePath: 'files/u/big.csv', fileSize: 100 * MIB + 1 });
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'big.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_file_too_large' } });
    expect(h.sourceDownload).not.toHaveBeenCalled();
  });

  it('refuses a file over the per-file limit by its bytes when the recorded size is lower', async () => {
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(
        OWNER,
        FN_ID,
        { fileId: 'file1', name: 'points.csv' },
        { storage, limits: { fileBytes: 4, totalBytes: LIMITS.totalBytes } }
      )
    ).rejects.toMatchObject({ additionalInfo: { code: 'data_file_too_large' } });
  });

  it('refuses a file that would take the function over its total', async () => {
    withPins([pinOf('a.csv', 1024 * MIB - 4)]);
    const { storage } = memoryStorage();
    await expect(
      pinCallableFunctionData(OWNER, FN_ID, { fileId: 'file1', name: 'points.csv' }, { storage, limits: LIMITS })
    ).rejects.toMatchObject({ statusCode: 400, additionalInfo: { code: 'data_total_too_large' } });
    expect(storage.upload).not.toHaveBeenCalled();
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
