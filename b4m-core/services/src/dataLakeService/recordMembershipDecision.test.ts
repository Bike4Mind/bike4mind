import { describe, it, expect, vi } from 'vitest';
import type { DuplicateGroup, ILakeMembershipDecision } from '@bike4mind/common';
import { groupIdentity } from '@bike4mind/common';
import { recordMembershipDecision } from './recordMembershipDecision';

const member = (fabFileId: string, serverTextHash: string | null = null): DuplicateGroup['members'][number] => ({
  fabFileId,
  serverTextHash,
  fileSize: 100,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  arm: 'meta-tag',
});

const group: Pick<DuplicateGroup, 'fileName' | 'members'> = {
  fileName: 'policy.md',
  members: [member('f-new', 'hash-new'), member('f-old', 'hash-old')],
};

const adapters = () => {
  const upsertDecision = vi.fn(async (input: ILakeMembershipDecision) => ({ ...input, id: 'row-1' }) as never);
  return { db: { lakeMembershipDecisions: { upsertDecision } }, upsertDecision };
};

describe('recordMembershipDecision', () => {
  it('stamps the identity of the group as it stands now, not one the caller supplies', async () => {
    const { db, upsertDecision } = adapters();

    await recordMembershipDecision('owner-1', 'lake-1', group, { decision: 'keep-both', source: 'repair' }, { db });

    expect(upsertDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        dataLakeId: 'lake-1',
        fileName: 'policy.md',
        decision: 'keep-both',
        keptFabFileId: null,
        groupIdentity: groupIdentity(group),
        decidedByUserId: 'owner-1',
        source: 'repair',
      })
    );
  });

  // The reason the function computes the identity itself: a ruling made against a two-member view
  // must be stamped against the three-member reality, so the next plan re-opens it rather than
  // suppressing a question the owner was never shown.
  it('stamps the live group when a third copy arrived since the plan the owner was looking at', async () => {
    const { db, upsertDecision } = adapters();
    const grown = { fileName: 'policy.md', members: [...group.members, member('f-third', 'hash-third')] };

    await recordMembershipDecision('owner-1', 'lake-1', grown, { decision: 'keep-both', source: 'repair' }, { db });

    const stamped = upsertDecision.mock.calls[0][0].groupIdentity;
    expect(stamped).toBe(groupIdentity(grown));
    expect(stamped).not.toBe(groupIdentity(group));
  });

  it('records the member a keep-specific ruling keeps', async () => {
    const { db, upsertDecision } = adapters();

    await recordMembershipDecision(
      'owner-1',
      'lake-1',
      group,
      { decision: 'keep-specific', keptFabFileId: 'f-old', source: 'repair' },
      { db }
    );

    expect(upsertDecision.mock.calls[0][0]).toMatchObject({ decision: 'keep-specific', keptFabFileId: 'f-old' });
  });

  it('rejects a keep-specific naming a member that is not in the group, and writes nothing', async () => {
    const { db, upsertDecision } = adapters();

    await expect(
      recordMembershipDecision(
        'owner-1',
        'lake-1',
        group,
        { decision: 'keep-specific', keptFabFileId: 'f-elsewhere', source: 'repair' },
        { db }
      )
    ).rejects.toThrow(/not part of this duplicate group/);
    expect(upsertDecision).not.toHaveBeenCalled();
  });

  it('rejects a keep-specific with no member named', async () => {
    const { db, upsertDecision } = adapters();

    await expect(
      recordMembershipDecision('owner-1', 'lake-1', group, { decision: 'keep-specific', source: 'repair' }, { db })
    ).rejects.toThrow(/requires the member to keep/);
    expect(upsertDecision).not.toHaveBeenCalled();
  });

  // Silently dropping the id would store a ruling that reads as deliberate and means something else.
  it('rejects a kept member on a decision that has no kept member', async () => {
    const { db } = adapters();

    await expect(
      recordMembershipDecision(
        'owner-1',
        'lake-1',
        group,
        { decision: 'keep-newest', keptFabFileId: 'f-old', source: 'repair' },
        { db }
      )
    ).rejects.toThrow(/only meaningful for keep-specific/);
  });

  it('carries the admission source through, so an upload-time ruling is distinguishable from a repair one', async () => {
    const { db, upsertDecision } = adapters();

    await recordMembershipDecision(
      'uploader-1',
      'lake-1',
      group,
      { decision: 'keep-both', source: 'admission' },
      { db }
    );

    expect(upsertDecision.mock.calls[0][0]).toMatchObject({ source: 'admission', decidedByUserId: 'uploader-1' });
  });
});
