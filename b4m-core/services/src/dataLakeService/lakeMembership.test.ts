import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, DATALAKE_TAG_STRENGTH, type IDataLakeDocument } from '@bike4mind/common';
import { addFileToLake, removeFileFromLake } from './lakeMembership';
import { withStorageOwnerFakes } from '../__tests__/utils/storageOwnerTransferFakes';

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
  // The pre-image the winning push saw: a stranger to the lake, so the write is a real join.
  const makeAdapters = (prior: unknown = { userId: 'owner', tags: [] }) => ({
    db: withStorageOwnerFakes({ fabFiles: { pushTagReturningPriorState: vi.fn().mockResolvedValue(prior) } }),
  });

  it('stamps the canonical meta-tag at the shared membership strength', async () => {
    const adapters = makeAdapters();

    await addFileToLake(owner, lake(), 'f1', adapters);

    // The tag comes off the lake document, so a mixed-case meta-tag in a request body cannot
    // create a second membership tag that no read arm matches.
    expect(adapters.db.fabFiles.pushTagReturningPriorState).toHaveBeenCalledWith('f1', 'datalake:lake', 1);
    expect(DATALAKE_TAG_STRENGTH).toBe(1);
  });

  it('lets an admin who did not create the lake add a file', async () => {
    const adapters = makeAdapters();

    await addFileToLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters);

    expect(adapters.db.fabFiles.pushTagReturningPriorState).toHaveBeenCalled();
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const adapters = makeAdapters();

    await expect(addFileToLake({ userId: 'stranger', isAdmin: false }, lake(), 'f1', adapters)).rejects.toThrow(
      /do not have permission to add files/i
    );
    expect(adapters.db.fabFiles.pushTagReturningPriorState).not.toHaveBeenCalled();
  });

  it('refuses a built-in fallback lake, which has no document to hold membership', async () => {
    const adapters = makeAdapters();

    await expect(addFileToLake({ userId: 'root', isAdmin: true }, fallbackLake, 'f1', adapters)).rejects.toThrow(
      /built into the platform and is read-only/i
    );
    expect(adapters.db.fabFiles.pushTagReturningPriorState).not.toHaveBeenCalled();
  });

  it('refuses a join onto a full org pool unless the caller already cleared the transfer', async () => {
    const orgLake = lake({ organizationId: 'org-full', createdAt: new Date(0) });
    const fullPoolAdapters = () => {
      const adapters = makeAdapters();
      adapters.db.fabFiles.findById.mockResolvedValue({
        id: 'f1',
        userId: 'owner',
        fileSize: 400,
        storageChargedAt: new Date(),
        tags: [],
      });
      adapters.db.dataLakes.findByDatalakeTags.mockResolvedValue([orgLake]);
      adapters.db.users.findById.mockResolvedValue({ id: 'owner' });
      adapters.db.organizations.findById.mockResolvedValue({
        id: 'org-full',
        currentStorageSize: 1024 * 1024,
        storageLimit: 1,
      });
      return adapters;
    };

    const gated = fullPoolAdapters();
    await expect(addFileToLake(owner, orgLake, 'f1', gated)).rejects.toThrow(/storage limit/i);
    expect(gated.db.fabFiles.pushTagReturningPriorState).not.toHaveBeenCalled();

    const cleared = fullPoolAdapters();
    await addFileToLake(owner, orgLake, 'f1', cleared, { ownerTransferPreCleared: true });
    expect(cleared.db.fabFiles.pushTagReturningPriorState).toHaveBeenCalled();
  });

  it('recomputes the owner even when the tag was already there, so a retry repairs a failed transfer', async () => {
    // Null pre-image: the filtered push matched nothing, as it does on a retry after the first
    // attempt threw between the tag write and the owner restamp.
    const adapters = makeAdapters(null);
    adapters.db.fabFiles.findById.mockResolvedValue({
      id: 'f1',
      userId: 'owner',
      organizationId: 'org1',
      tags: [{ name: 'datalake:lake', strength: 1 }],
    });

    await addFileToLake(owner, lake(), 'f1', adapters);

    expect(adapters.db.fabFiles.setOwnerOrganizationIfUnchanged).toHaveBeenCalledWith(
      'f1',
      expect.anything(),
      undefined
    );
  });

  describe('membership event', () => {
    const makeAuditedAdapters = (prior: unknown = { userId: 'owner', tags: [] }) => ({
      db: withStorageOwnerFakes({
        fabFiles: { pushTagReturningPriorState: vi.fn().mockResolvedValue(prior) },
        lakeMembershipChangeEvents: { record: vi.fn().mockResolvedValue({}) },
      }),
    });

    it('records an `added` event, defaulting to `person` origin', async () => {
      const adapters = makeAuditedAdapters();

      await addFileToLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'f1', action: 'added', origin: 'person' })
      );
    });

    it('records `connector` when the call site says so - e.g. the Drive ingest handler', async () => {
      const adapters = makeAuditedAdapters();

      await addFileToLake(owner, lake(), 'f1', adapters, { origin: 'connector' });

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'connector' })
      );
    });

    it('records the join before the owner restamp, so a restamp that throws cannot lose it', async () => {
      const adapters = makeAuditedAdapters();
      adapters.db.fabFiles.findById
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('simulated crash in the restamp'));

      await expect(addFileToLake(owner, lake(), 'f1', adapters)).rejects.toThrow('simulated crash in the restamp');

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'added' })
      );
    });

    it('records nothing for a no-op re-add of an existing member', async () => {
      // Null pre-image: the filtered push matched nothing, so the meta-tag was already there.
      const adapters = makeAuditedAdapters(null);

      await addFileToLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.lakeMembershipChangeEvents.record).not.toHaveBeenCalled();
    });

    it('records nothing when the file was already a member through the prefix arm', async () => {
      // A creator-owned file carrying a tag under the lake's fileTagPrefix already matches the
      // read path's prefix arm. Stamping in its missing meta-tag is not a join, so a row for it
      // would claim a transition that never happened.
      const adapters = makeAuditedAdapters({ userId: 'owner', tags: [{ name: 'lk:q1', strength: 0 }] });

      await addFileToLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.fabFiles.pushTagReturningPriorState).toHaveBeenCalled();
      expect(adapters.db.lakeMembershipChangeEvents.record).not.toHaveBeenCalled();
    });

    it('records the join when the same prefix tag sits on a file the lake creator does not own', async () => {
      // The prefix arm is anchored to the LAKE'S CREATOR owning the file, so a stranger's file
      // carrying `lk:q1` is not a member through it - this really is a join.
      const adapters = makeAuditedAdapters({ userId: 'someone-else', tags: [{ name: 'lk:q1', strength: 0 }] });

      await addFileToLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'added' })
      );
    });
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
    db: withStorageOwnerFakes({
      fabFiles: {
        findById: vi.fn().mockResolvedValue(fileInLake),
        pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
      },
    }),
  });

  it('recomputes the owner even when another writer already pulled the tags', async () => {
    // A concurrent removal, or a retry after a failed restamp, leaves nothing to pull - but the
    // stamp still has to be reconciled with the tags that are now stored.
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi.fn().mockResolvedValue({ ...fileInLake, organizationId: 'org-sales' }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(0),
        },
      }),
    };

    await removeFileFromLake(owner, lake(), 'f1', adapters);
    expect(adapters.db.memoryLedger.markSourceShredded).toHaveBeenCalledWith('lake', 'datalake:lake', 'owner', 'f1');

    expect(adapters.db.fabFiles.setOwnerOrganizationIfUnchanged).toHaveBeenCalledWith(
      'f1',
      expect.anything(),
      undefined
    );
  });

  it('shreds the beliefs a file contributed when it is no longer a member', async () => {
    // A stale caller still asking to remove a file the lake no longer holds must not leave behind
    // beliefs distilled from it: the refusal below is the last place that can shred them.
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'unrelated', strength: 0 }] }),
          pullTagsByFabFileId: vi.fn(),
        },
      }),
    };

    await expect(removeFileFromLake(owner, lake(), 'f1', adapters)).rejects.toThrow('File not found in this data lake');

    expect(adapters.db.memoryLedger.markSourceShredded).toHaveBeenCalledWith('lake', 'datalake:lake', 'owner', 'f1');
  });

  it('restamps a file no longer in the lake before refusing it, so a retry repairs a failed transfer', async () => {
    // The state a retry finds after the first attempt pulled the tags and then threw in the restamp.
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi.fn().mockResolvedValue({
            id: 'f1',
            userId: 'owner',
            organizationId: 'org-sales',
            tags: [{ name: 'unrelated', strength: 0 }],
          }),
          pullTagsByFabFileId: vi.fn(),
        },
      }),
    };

    await expect(removeFileFromLake(owner, lake(), 'f1', adapters)).rejects.toThrow(/not found in this data lake/i);

    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
    expect(adapters.db.fabFiles.setOwnerOrganizationIfUnchanged).toHaveBeenCalledWith(
      'f1',
      expect.anything(),
      undefined
    );
  });

  it('clears the membership signals without recomputing stats', async () => {
    const adapters = makeAdapters();

    await removeFileFromLake(owner, lake(), 'f1', adapters);

    // Both signals the read scope ORs, and nothing else.
    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake', 'lk:invoices']);
  });

  // #2248: the return value carries what the removal pulled, so a restore can push back the real
  // tags rather than a placeholder. Widened from `void`; every existing caller ignores the return.
  it('returns the pulled content tags with their stored strengths, excluding the meta-tag', async () => {
    const adapters = makeAdapters();

    const result = await removeFileFromLake(owner, lake(), 'f1', adapters);

    expect(result).toEqual({ contentTags: [{ name: 'lk:invoices', strength: 1 }] });
  });

  it('returns empty contentTags for a meta-tag-only member (nothing to restore)', async () => {
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'datalake:lake', strength: 1 }] }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      }),
    };

    const result = await removeFileFromLake(owner, lake(), 'f1', adapters);

    expect(result).toEqual({ contentTags: [] });
  });

  it('returns empty contentTags for a file the lake creator does not own, even when admitted by meta-tag', async () => {
    // Same fixture as "strips only the meta-tag" above: admitted via the meta-tag arm only, so the
    // prefix-matching tag is a bystander this lake never actually held as content.
    const adapters = {
      db: withStorageOwnerFakes({
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
      }),
    };

    const result = await removeFileFromLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters);

    expect(result).toEqual({ contentTags: [] });
  });

  it('refuses a caller who cannot manage the lake', async () => {
    const adapters = makeAdapters();

    await expect(removeFileFromLake({ userId: 'stranger', isAdmin: false }, lake(), 'f1', adapters)).rejects.toThrow(
      /do not have permission to remove files/i
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
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'victim', tags: [{ name: 'lk:invoices', strength: 1 }] }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      }),
    };

    await expect(removeFileFromLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters)).rejects.toThrow(
      /not found in this data lake/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('refuses the lake creator removing a prefix-only file merely shared with them (#1040)', async () => {
    // Same code path as the admin test above - ownsFile never reads file.users/file.groups - but
    // spelled out for #1040's literal scenario: the ACTOR here is the lake's own creator (passes
    // canManageLake trivially), and the file's owner shared it with them read/write. A share is
    // not ownership, so the outcome is identical to the admin case.
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi.fn().mockResolvedValue({
            id: 'f1',
            userId: 'victim',
            users: [{ userId: 'owner', permissions: ['read', 'write'] }],
            tags: [{ name: 'lk:invoices', strength: 1 }],
          }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      }),
    };

    await expect(removeFileFromLake(owner, lake(), 'f1', adapters)).rejects.toThrow(/not found in this data lake/i);
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  it('strips only the meta-tag, not a bystander prefix-matching tag, on a file the creator does not own', async () => {
    // Admitted to inLake via the meta-tag arm only (e.g. an admin's addFileToLake added a
    // stranger's file) - the read path's prefix arm never admitted this file since it is not
    // owned by the lake's creator, so removal must not strip its coincidentally-matching tag.
    const adapters = {
      db: withStorageOwnerFakes({
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
      }),
    };

    await removeFileFromLake({ userId: 'root', isAdmin: true }, lake(), 'f1', adapters);

    expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalledWith('f1', ['datalake:lake']);
  });

  it('ignores a legacy reserved-namespace fileTagPrefix rather than matching every other lake', async () => {
    // A prefix inside datalake: (predates the create-time guard that now rejects it) must not
    // treat an unrelated lake's meta-tag as this lake's own prefix-tagged content.
    const reservedPrefixLake = lake({ fileTagPrefix: 'datalake:evil:' });
    const adapters = {
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi
            .fn()
            .mockResolvedValue({ id: 'f1', userId: 'owner', tags: [{ name: 'datalake:other', strength: 1 }] }),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
      }),
    };

    await expect(removeFileFromLake(owner, reservedPrefixLake, 'f1', adapters)).rejects.toThrow(
      /not found in this data lake/i
    );
    expect(adapters.db.fabFiles.pullTagsByFabFileId).not.toHaveBeenCalled();
  });

  describe('membership event (#3052)', () => {
    const makeAuditedAdapters = () => ({
      db: withStorageOwnerFakes({
        fabFiles: {
          findById: vi.fn().mockResolvedValue(fileInLake),
          pullTagsByFabFileId: vi.fn().mockResolvedValue(1),
        },
        lakeMembershipChangeEvents: { record: vi.fn().mockResolvedValue({}) },
      }),
    });

    it('records a `removed` event, defaulting to `person` origin, after the pull lands', async () => {
      const adapters = makeAuditedAdapters();

      await removeFileFromLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'f1', action: 'removed', origin: 'person' })
      );
    });

    it('records `connector` when the call site says so', async () => {
      const adapters = makeAuditedAdapters();

      await removeFileFromLake(owner, lake(), 'f1', adapters, { origin: 'connector' });

      expect(adapters.db.lakeMembershipChangeEvents.record).toHaveBeenCalledWith(
        expect.objectContaining({ origin: 'connector' })
      );
    });

    // The losing half of two concurrent removals: both requests read the file as a member, the
    // first pull clears the tags, and this one matches nothing. Recording off the earlier read
    // would append a second `removed` for a single transition.
    it('never records when the atomic pull reports no modification', async () => {
      const adapters = makeAuditedAdapters();
      adapters.db.fabFiles.pullTagsByFabFileId = vi.fn().mockResolvedValue(0);

      await removeFileFromLake(owner, lake(), 'f1', adapters);

      expect(adapters.db.fabFiles.pullTagsByFabFileId).toHaveBeenCalled();
      expect(adapters.db.lakeMembershipChangeEvents.record).not.toHaveBeenCalled();
    });

    it('never records when the member refusal throws first', async () => {
      const adapters = {
        db: withStorageOwnerFakes({
          fabFiles: { findById: vi.fn().mockResolvedValue(null), pullTagsByFabFileId: vi.fn() },
          lakeMembershipChangeEvents: { record: vi.fn().mockResolvedValue({}) },
        }),
      };

      await expect(removeFileFromLake(owner, lake(), 'f1', adapters)).rejects.toThrow(/not found/i);
      expect(adapters.db.lakeMembershipChangeEvents.record).not.toHaveBeenCalled();
    });
  });
});
