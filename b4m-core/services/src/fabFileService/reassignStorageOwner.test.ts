import { describe, expect, it, vi } from 'vitest';
import { ConflictError, StorageLimitError } from '@bike4mind/common';
import { assertStorageOwnerTransferFits, reassignStorageOwner } from './reassignStorageOwner';

const CHARGED = new Date('2026-10-10T00:00:00Z');

const orgLake = (tag: string, organizationId: string, createdAt: string) => ({
  id: `lake-${tag}`,
  datalakeTag: `datalake:${tag}`,
  organizationId,
  createdAt: new Date(createdAt),
});
const personalLake = (tag: string) => ({
  id: `lake-${tag}`,
  datalakeTag: `datalake:${tag}`,
  createdAt: new Date('2026-01-01'),
});

const LAKES = [
  orgLake('acme', 'org-acme', '2026-01-01'),
  orgLake('globex', 'org-globex', '2026-02-01'),
  orgLake('initech', 'org-initech', '2026-03-01'),
  personalLake('mine'),
];

type FakeFile = {
  id: string;
  userId: string;
  organizationId?: string;
  sourceLakeId?: string;
  fileSize: number;
  storageChargedAt?: Date;
  status?: 'pending' | 'complete';
  createdAt: Date;
  tags: { name: string; strength: number }[];
};

const file = (tags: string[], overrides: Partial<FakeFile> = {}): FakeFile => ({
  id: 'f1',
  userId: 'u1',
  fileSize: 100,
  storageChargedAt: CHARGED,
  status: 'complete',
  createdAt: new Date('2026-10-09'),
  tags: tags.map(name => ({ name, strength: 1 })),
  ...overrides,
});

const makeDb = (row: FakeFile | null, { casResults = [true] }: { casResults?: boolean[] } = {}) => {
  const counters = { users: new Map<string, number>(), orgs: new Map<string, number>() };
  const cas = [...casResults];
  const db = {
    fabFiles: {
      findById: vi.fn(async () => (row ? { ...row } : null)),
      setOwnerOrganizationIfUnchanged: vi.fn(async (_id: string, _expected: unknown, next: string | undefined) => {
        const won = cas.length ? cas.shift()! : true;
        if (won && row) row.organizationId = next;
        return won;
      }),
    },
    dataLakes: {
      findByDatalakeTags: vi.fn(async (tags: string[]) => LAKES.filter(lake => tags.includes(lake.datalakeTag))),
    },
    users: {
      findById: vi.fn(async (id: string) => ({ id, currentStorageSize: 0, storageLimit: 1000 })),
      incrementCurrentStorage: vi.fn(async (id: string, bytes: number) => {
        counters.users.set(id, (counters.users.get(id) ?? 0) + bytes);
      }),
    },
    organizations: {
      findById: vi.fn(async (id: string) => ({ id, currentStorageSize: 0, storageLimit: 1000 })),
      incrementCurrentStorage: vi.fn(async (id: string, bytes: number) => {
        counters.orgs.set(id, (counters.orgs.get(id) ?? 0) + bytes);
      }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial repository fakes
  return { db: db as any, raw: db, counters };
};

describe('reassignStorageOwner', () => {
  it('moves a personal file that joined an org lake onto the org', async () => {
    const row = file(['datalake:acme']);
    const { db, counters } = makeDb(row);

    const transfer = await reassignStorageOwner('f1', db);

    expect(transfer).toMatchObject({
      from: { type: 'user', id: 'u1' },
      to: { type: 'org', id: 'org-acme' },
      bytes: 100,
    });
    expect(row.organizationId).toBe('org-acme');
    expect(counters.users.get('u1')).toBe(-100);
    expect(counters.orgs.get('org-acme')).toBe(100);
  });

  it('sends a file that left every org lake back to its uploader', async () => {
    const row = file(['datalake:mine'], { organizationId: 'org-acme' });
    const { db, raw, counters } = makeDb(row);

    await reassignStorageOwner('f1', db);

    expect(raw.fabFiles.setOwnerOrganizationIfUnchanged).toHaveBeenCalledWith('f1', expect.anything(), undefined);
    expect(row.organizationId).toBeUndefined();
    expect(counters.orgs.get('org-acme')).toBe(-100);
    expect(counters.users.get('u1')).toBe(100);
  });

  it('moves the file between orgs when it leaves the owning org lake but stays in another', async () => {
    const row = file(['datalake:globex'], { organizationId: 'org-acme' });
    const { db, counters } = makeDb(row);

    await reassignStorageOwner('f1', db);

    expect(row.organizationId).toBe('org-globex');
    expect(counters.orgs.get('org-acme')).toBe(-100);
    expect(counters.orgs.get('org-globex')).toBe(100);
    expect(counters.users.size).toBe(0);
  });

  it('keeps the file on the lake that ingested it over an older org lake', async () => {
    const row = file(['datalake:acme', 'datalake:globex'], {
      organizationId: 'org-globex',
      sourceLakeId: 'lake-globex',
    });
    const { db, raw } = makeDb(row);

    expect(await reassignStorageOwner('f1', db)).toBeNull();
    expect(raw.fabFiles.setOwnerOrganizationIfUnchanged).not.toHaveBeenCalled();
  });

  it('falls back to the oldest remaining org lake once the ingesting lake is removed', async () => {
    const row = file(['datalake:initech', 'datalake:globex'], {
      organizationId: 'org-acme',
      sourceLakeId: 'lake-acme',
    });
    const { db, counters } = makeDb(row);

    await reassignStorageOwner('f1', db);

    expect(row.organizationId).toBe('org-globex');
    expect(counters.orgs.get('org-acme')).toBe(-100);
    expect(counters.orgs.get('org-globex')).toBe(100);
  });

  it('sends the file to its uploader once the ingesting lake is removed and no org lake remains', async () => {
    const row = file(['datalake:mine'], { organizationId: 'org-acme', sourceLakeId: 'lake-acme' });
    const { db, counters } = makeDb(row);

    await reassignStorageOwner('f1', db);

    expect(row.organizationId).toBeUndefined();
    expect(counters.orgs.get('org-acme')).toBe(-100);
    expect(counters.users.get('u1')).toBe(100);
  });

  it.each(['deleted', 'purging'])('ignores a %s lake when picking the owner', async status => {
    const row = file(['datalake:acme', 'datalake:globex'], { organizationId: 'org-acme' });
    const { db, raw, counters } = makeDb(row);
    raw.dataLakes.findByDatalakeTags.mockImplementation(async (tags: string[]) =>
      LAKES.filter(lake => tags.includes(lake.datalakeTag)).map(lake =>
        lake.id === 'lake-acme' ? { ...lake, status } : { ...lake, status: 'active' }
      )
    );

    await reassignStorageOwner('f1', db);

    expect(row.organizationId).toBe('org-globex');
    expect(counters.orgs.get('org-acme')).toBe(-100);
    expect(counters.orgs.get('org-globex')).toBe(100);
  });

  it('writes nothing when the owner is unchanged', async () => {
    const { db, raw } = makeDb(file(['datalake:acme', 'datalake:mine'], { organizationId: 'org-acme' }));

    expect(await reassignStorageOwner('f1', db)).toBeNull();
    expect(raw.fabFiles.setOwnerOrganizationIfUnchanged).not.toHaveBeenCalled();
    expect(raw.users.incrementCurrentStorage).not.toHaveBeenCalled();
    expect(raw.organizations.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('restamps an uncharged file without moving bytes', async () => {
    const row = file(['datalake:acme'], { storageChargedAt: undefined, status: 'pending' });
    const { db, raw } = makeDb(row);

    await reassignStorageOwner('f1', db);

    expect(row.organizationId).toBe('org-acme');
    expect(raw.users.incrementCurrentStorage).not.toHaveBeenCalled();
    expect(raw.organizations.incrementCurrentStorage).not.toHaveBeenCalled();
  });

  it('re-reads after a lost compare-and-set instead of moving a stale count', async () => {
    const row = file(['datalake:acme']);
    const { db, raw, counters } = makeDb(row, { casResults: [false, true] });

    await reassignStorageOwner('f1', db);

    expect(raw.fabFiles.findById).toHaveBeenCalledTimes(2);
    expect(counters.orgs.get('org-acme')).toBe(100);
    expect(counters.users.get('u1')).toBe(-100);
  });

  it('keeps the org stamp when a concurrent join lands between a removal read and its write', async () => {
    // Request 1 already pulled the file out of its only lake (acme) and reads no lake tags.
    // Request 2 then adds it to another acme-org lake; its own reassign sees the stamp already
    // right and writes nothing. Request 1 must not unstamp the file on the strength of its read.
    const row = file([], { organizationId: 'org-acme' });
    const { db, raw, counters } = makeDb(row);
    raw.dataLakes.findByDatalakeTags.mockImplementation(async (tags: string[]) =>
      [...LAKES, orgLake('acme-two', 'org-acme', '2026-04-01')].filter(lake => tags.includes(lake.datalakeTag))
    );
    raw.fabFiles.findById.mockImplementationOnce(async () => {
      const removalRead = { ...row, tags: [...row.tags] };
      row.tags.push({ name: 'datalake:acme-two', strength: 1 });
      return removalRead;
    });
    // The repository CAS compares the stored tag-name set with the read's.
    raw.fabFiles.setOwnerOrganizationIfUnchanged.mockImplementation(
      async (_id: string, expected: unknown, next: string | undefined) => {
        const read = expected as FakeFile;
        const names = (tags: FakeFile['tags']) => [...new Set(tags.map(tag => tag.name))].sort().join('|');
        if (read.organizationId !== row.organizationId || names(read.tags) !== names(row.tags)) return false;
        row.organizationId = next;
        return true;
      }
    );

    expect(await reassignStorageOwner('f1', db)).toBeNull();

    expect(row.organizationId).toBe('org-acme');
    expect(raw.fabFiles.findById).toHaveBeenCalledTimes(2);
    expect(counters.users.size).toBe(0);
    expect(counters.orgs.size).toBe(0);
  });

  it('gives up with a ConflictError after three lost compare-and-sets, moving nothing', async () => {
    const row = file(['datalake:acme']);
    const { db, raw, counters } = makeDb(row, { casResults: [false, false, false] });

    await expect(reassignStorageOwner('f1', db)).rejects.toBeInstanceOf(ConflictError);
    expect(raw.fabFiles.setOwnerOrganizationIfUnchanged).toHaveBeenCalledTimes(3);
    expect(row.organizationId).toBeUndefined();
    expect(counters.users.size).toBe(0);
    expect(counters.orgs.size).toBe(0);
  });

  it('does nothing for a file that is gone', async () => {
    const { db, raw } = makeDb(null);

    expect(await reassignStorageOwner('f1', db)).toBeNull();
    expect(raw.dataLakes.findByDatalakeTags).not.toHaveBeenCalled();
  });
});

describe('assertStorageOwnerTransferFits', () => {
  it("refuses a join that would push the org's pool past its limit", async () => {
    const { db, raw } = makeDb(null);
    // storageLimit is in MB: a 1 MB pool already holding 1 MiB has no room for 100 more bytes.
    raw.organizations.findById.mockResolvedValue({ id: 'org-acme', currentStorageSize: 1024 * 1024, storageLimit: 1 });

    await expect(assertStorageOwnerTransferFits(file([]), ['datalake:acme'], db)).rejects.toBeInstanceOf(
      StorageLimitError
    );
  });

  it('lets a join through when the org has room', async () => {
    const { db } = makeDb(null);

    await expect(assertStorageOwnerTransferFits(file([]), ['datalake:acme'], db)).resolves.toMatchObject({
      to: { type: 'org', id: 'org-acme' },
    });
  });

  it('does not check quota when the owner would not change', async () => {
    const { db, raw } = makeDb(null);

    await assertStorageOwnerTransferFits(
      file(['datalake:acme'], { organizationId: 'org-acme' }),
      ['datalake:acme', 'datalake:globex'],
      db
    );

    expect(raw.organizations.findById).not.toHaveBeenCalled();
  });

  it('does not check quota for an uncharged file, which moves no bytes', async () => {
    const { db, raw } = makeDb(null);

    await assertStorageOwnerTransferFits(
      file([], { storageChargedAt: undefined, status: 'pending' }),
      ['datalake:acme'],
      db
    );

    expect(raw.organizations.findById).not.toHaveBeenCalled();
  });
});
