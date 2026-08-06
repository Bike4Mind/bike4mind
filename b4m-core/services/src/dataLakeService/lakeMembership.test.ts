import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, DATALAKE_TAG_STRENGTH, type IDataLakeDocument } from '@bike4mind/common';
import { addFileToLake, removeFileFromLake } from './lakeMembership';

const lake = (overrides: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({
    id: 'lake1',
    name: 'Lake',
    slug: 'lake',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake',
    createdByUserId: 'owner',
    status: 'active',
    ...overrides,
  }) as IDataLakeDocument;

const owner = { userId: 'owner', isAdmin: false };

// A lake with no Mongo document behind it, so there is nothing for a membership write to land on.
const fallbackLake = lake({ id: DATA_LAKES[0].id, datalakeTag: DATA_LAKES[0].datalakeTag });

describe('addFileToLake', () => {
  const makeAdapters = () => ({ db: { fabFiles: { pushTagsByFabFileId: vi.fn().mockResolvedValue(1) } } });

  it('stamps the canonical meta-tag at the shared membership strength', async () => {
    const adapters = makeAdapters();

    await addFileToLake(owner, lake(), 'f1', adapters);

    // The tag comes off the lake document, so a mixed-case meta-tag in a request body cannot
    // create a second membership tag that no read arm matches.
    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake'], 1);
    expect(DATALAKE_TAG_STRENGTH).toBe(1);
  });

  it('lets an admin who did not create the lake add a file', async () => {
    const adapters = makeAdapters();

    await addFileToLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters);

    expect(adapters.db.fabFiles.pushTagsByFabFileId).toHaveBeenCalled();
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const adapters = makeAdapters();

    await expect(addFileToLake({ userId: 'stranger', isAdmin: false }, lake(), 'f1', adapters)).rejects.toThrow(
      /only the creator can add files/i
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a built-in fallback lake, which has no document to hold membership', async () => {
    const adapters = makeAdapters();

    await expect(addFileToLake({ userId: 'root', isAdmin: true }, fallbackLake, 'f1', adapters)).rejects.toThrow(
      /built into the platform and is read-only/i
    );
    expect(adapters.db.fabFiles.pushTagsByFabFileId).not.toHaveBeenCalled();
  });
});

// The membership half of removeFileFromDataLake is covered end to end through that entry point
// in dataLakeService.test.ts. These pin the gates a direct caller (the tag-toggle door) depends
// on, which no route-level assert protects.
describe('removeFileFromLake', () => {
  // Both membership signals plus a bystander tag, so the prefix-clearing branch is exercised
  // and over-clearing would show up.
  const fileInLake = {
    id: 'f1',
    userId: 'owner',
    tags: [
      { name: 'datalake:lake', strength: 1 },
      { name: 'lk:invoices', strength: 1 },
      { name: 'unrelated', strength: 0 },
    ],
  };

  const makeAdapters = () => ({
    db: {
      fabFiles: {
        findById: vi.fn().mockResolvedValue(fileInLake),
        pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
      },
    },
  });

  it('clears the membership signals without recomputing stats', async () => {
    const adapters = makeAdapters();

    await removeFileFromLake(owner, lake(), 'f1', adapters);

    // Both signals the read scope ORs, and nothing else.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const adapters = makeAdapters();

    await expect(removeFileFromLake({ userId: 'stranger', isAdmin: false }, lake(), 'f1', adapters)).rejects.toThrow(
      /only the creator can remove files/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses a built-in fallback lake', async () => {
    const adapters = makeAdapters();

    await expect(removeFileFromLake({ userId: 'root', isAdmin: true }, fallbackLake, 'f1', adapters)).rejects.toThrow(
      /built into the platform and is read-only/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses even an admin clearing a prefixed tag on a file the lake creator does not own', async () => {
    // Prefix-only (no meta-tag), owned by someone other than lake()'s creator ('owner'), so the
    // outcome is decided entirely by the ownership conjunct, not the meta-tag arm.
    const adapters = {
      db: {
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'victim', tags: [{ name: 'lk:invoices', strength: 1 }] }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      },
    };

    await expect(removeFileFromLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters)).rejects.toThrow(
      /not found in this data lake/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('strips only the meta-tag, not a bystander prefix-matching tag, on a file the creator does not own', async () => {
    // Admitted to inLake via the meta-tag arm only (e.g. an admin's addFileToLake added a
    // stranger's file) - the read path's prefix arm never admitted this file since it is not
    // owned by the lake's creator, so removal must not strip its coincidentally-matching tag.
    const adapters = {
      db: {
        fabFiles: {
          findById: vi.fn().mockResolvedValue({
            id: 'f1',
            userId: 'victim',
            tags: [
              { name: 'datalake:lake', strength: 1 },
              { name: 'lk:invoices', strength: 1 },
            ],
          }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      },
    };

    await removeFileFromLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters);

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('ignores a legacy reserved-namespace fileTagPrefix rather than matching every other lake', async () => {
    // A prefix inside datalake: (predates the create-time guard that now rejects it) must not
    // treat an unrelated lake's meta-tag as this lake's own prefix-tagged content.
    const reservedPrefixLake = lake({ fileTagPrefix: 'datalake:evil:' });
    const adapters = {
      db: {
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'datalake:other', strength: 1 }] }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      },
    };

    await expect(removeFileFromLake(owner, reservedPrefixLake, 'f1', adapters)).rejects.toThrow(
      /not found in this data lake/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });
});
