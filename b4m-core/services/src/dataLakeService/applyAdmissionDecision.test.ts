import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ILakeMembershipDecision, LakeMembershipMemberRow } from '@bike4mind/common';
import { applyAdmissionDecision, type ApplyAdmissionDecisionAdapters } from './applyAdmissionDecision';

const removeFileFromDataLake = vi.fn(async () => ({ success: true as const, fileCount: 1, totalSizeBytes: 1 }));
vi.mock('./removeFileFromDataLake', () => ({
  removeFileFromDataLake: (...args: unknown[]) => removeFileFromDataLake(...(args as [])),
}));

const LAKE = {
  id: 'lake-1',
  datalakeTag: 'datalake:acme',
  fileTagPrefix: 'acme:',
  createdByUserId: 'creator-1',
};
const ACTOR = { userId: 'creator-1', isAdmin: false };

const row = (over: Partial<LakeMembershipMemberRow> & { fabFileId: string }): LakeMembershipMemberRow => ({
  fileName: 'policy.md',
  serverTextHash: 'aaa',
  fileSize: 100,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  userId: 'creator-1',
  arm: 'meta-tag',
  relativePath: null,
  driveFileId: null,
  ...over,
});

const NEWEST = row({ fabFileId: 'new-1', createdAt: new Date('2026-03-01T00:00:00Z') });
const OLDEST = row({ fabFileId: 'old-1', createdAt: new Date('2026-01-01T00:00:00Z') });

const adapters = (members: LakeMembershipMemberRow[] = [NEWEST, OLDEST]) => {
  const findLakeMemberSiblingsByFileName = vi.fn(async () => members);
  const upsertDecision = vi.fn(async (input: ILakeMembershipDecision) => ({ ...input, id: 'row-1' }));
  const bag = {
    db: { fabFiles: { findLakeMemberSiblingsByFileName }, lakeMembershipDecisions: { upsertDecision } },
  } as unknown as ApplyAdmissionDecisionAdapters;
  return { bag, findLakeMemberSiblingsByFileName, upsertDecision };
};

beforeEach(() => {
  removeFileFromDataLake.mockClear();
});

describe('applyAdmissionDecision', () => {
  it('records the ruling as source admission, stamped over the WHOLE group', async () => {
    const { bag, upsertDecision, findLakeMemberSiblingsByFileName } = adapters();

    const result = await applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-both' }, bag);

    // Read fresh, and with no exclusion: a ruling covers every member the group holds.
    expect(findLakeMemberSiblingsByFileName).toHaveBeenCalledWith(
      { kind: 'owned', datalakeTag: 'datalake:acme', fileTagPrefix: 'acme:', creatorUserId: 'creator-1' },
      'policy.md'
    );
    expect(upsertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake-1',
        fileName: 'policy.md',
        decision: 'keep-both',
        source: 'admission',
        decidedByUserId: 'creator-1',
      })
    );
    // Both members are in the stamped identity, so a repair run reading this row settles the pair
    // rather than re-asking about it.
    const { groupIdentity } = upsertDecision.mock.calls[0][0];
    expect(groupIdentity).toContain('new-1');
    expect(groupIdentity).toContain('old-1');
    expect(result.removedFabFileIds).toEqual([]);
  });

  it('keep-both removes nothing', async () => {
    const { bag } = adapters();

    await applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-both' }, bag);

    expect(removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('keep-newest removes every older copy through the ordinary removal door', async () => {
    // Going through removeFileFromDataLake rather than a bespoke write is what makes a replacement
    // lake-scoped and gives it an Undo - see the module comment.
    const { bag } = adapters();

    const result = await applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-newest' }, bag);

    expect(result.removedFabFileIds).toEqual(['old-1']);
    expect(removeFileFromDataLake).toHaveBeenCalledTimes(1);
    expect(removeFileFromDataLake).toHaveBeenCalledWith(ACTOR, 'lake-1', 'old-1', bag);
  });

  it('keep-specific keeps the named member and removes the rest', async () => {
    const { bag } = adapters();

    const result = await applyAdmissionDecision(
      ACTOR,
      LAKE,
      { fileName: 'policy.md', decision: 'keep-specific', keptFabFileId: 'old-1' },
      bag
    );

    expect(result.removedFabFileIds).toEqual(['new-1']);
  });

  it('records BEFORE it removes, so a failed removal is visible instead of a re-asked question', async () => {
    const { bag, upsertDecision } = adapters();
    const order: string[] = [];
    upsertDecision.mockImplementation(async input => (order.push('record'), { ...input, id: 'row-1' }));
    removeFileFromDataLake.mockImplementation(async () => {
      order.push('remove');
      throw new Error('removal failed');
    });

    await expect(
      applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-newest' }, bag)
    ).rejects.toThrow('removal failed');

    expect(order).toEqual(['record', 'remove']);
    // The ruling survived the failure. The plan reports the un-carried-out removal as
    // `outstandingRemovalFabFileIds`; the reverse order would have re-opened a settled question.
    expect(upsertDecision).toHaveBeenCalledTimes(1);
  });

  it('refuses a name that no longer has duplicate members, rather than reporting success', async () => {
    const { bag, upsertDecision } = adapters([NEWEST]);

    await expect(
      applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-newest' }, bag)
    ).rejects.toThrow('no longer has duplicate members');

    expect(upsertDecision).not.toHaveBeenCalled();
    expect(removeFileFromDataLake).not.toHaveBeenCalled();
  });

  it('refuses a name whose copies the identity key proves are different documents', async () => {
    // Two unrelated `policy.md` under different folders. There is no duplicate to rule on, so
    // recording a ruling would suppress a question that was never valid.
    const { bag, upsertDecision } = adapters([
      row({ fabFileId: 'a', relativePath: 'legal/' }),
      row({ fabFileId: 'b', relativePath: 'archive/' }),
    ]);

    await expect(
      applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-newest' }, bag)
    ).rejects.toThrow('no longer has duplicate members');

    expect(upsertDecision).not.toHaveBeenCalled();
  });

  it('removes sequentially, so two stat recomputes cannot overwrite each other', async () => {
    const { bag } = adapters([
      NEWEST,
      OLDEST,
      row({ fabFileId: 'old-2', createdAt: new Date('2026-02-01T00:00:00Z') }),
    ]);
    let inFlight = 0;
    let overlapped = false;
    removeFileFromDataLake.mockImplementation(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight -= 1;
      return { success: true as const, fileCount: 1, totalSizeBytes: 1 };
    });

    const result = await applyAdmissionDecision(ACTOR, LAKE, { fileName: 'policy.md', decision: 'keep-newest' }, bag);

    expect(result.removedFabFileIds).toEqual(['old-2', 'old-1']);
    expect(overlapped).toBe(false);
  });
});
