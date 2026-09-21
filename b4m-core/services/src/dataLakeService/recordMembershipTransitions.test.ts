import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { recordMembershipTransitions, type MembershipTransitionFile } from './recordMembershipTransitions';
import type { MembershipLake } from './lakeMembership';

describe('recordMembershipTransitions', () => {
  const userId = 'owner-1';

  const lake = (overrides: Partial<IDataLakeDocument> = {}): MembershipLake =>
    ({
      id: 'lake1',
      name: 'Lake',
      fileTagPrefix: 'lk:',
      datalakeTag: 'datalake:lake',
      createdByUserId: userId,
      ...overrides,
    }) as MembershipLake;

  const file = (overrides: Partial<MembershipTransitionFile> = {}): MembershipTransitionFile => ({
    fabFileId: 'file1',
    userId,
    beforeTagNames: [],
    afterTagNames: [],
    ...overrides,
  });

  const audit = () => {
    const record = vi.fn().mockResolvedValue({});
    return { record, adapters: { db: { lakeMembershipChangeEvents: { record } } } };
  };

  const actor = { userId, isAdmin: false };

  it('records a removal when the file loses its only prefix-arm signal', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake()],
      [file({ beforeTagNames: ['lk:reports'], afterTagNames: [] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: 'lake1', fabFileId: 'file1', action: 'removed', origin: 'person' })
    );
  });

  it('records an addition when the file newly satisfies the prefix arm', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake()],
      [file({ beforeTagNames: ['archived'], afterTagNames: ['lk:reports'] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'added' }));
  });

  // The whole reason membership is decided by the scope predicate rather than by the prefix alone:
  // the meta-tag arm keeps this file a member, so nothing moved.
  it('records nothing when the meta-tag keeps the file a member through the prefix loss', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake()],
      [file({ beforeTagNames: ['lk:reports', 'datalake:lake'], afterTagNames: ['datalake:lake'] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing for a file that stays out of the lake on both sides', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake()],
      [file({ beforeTagNames: ['foo'], afterTagNames: ['bar'] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).not.toHaveBeenCalled();
  });

  // The prefix arm is anchored to the LAKE's creator owning the file, so a file owned by anyone
  // else was never reachable through it and never moves.
  it('records nothing for a file the lake creator does not own', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake()],
      [file({ userId: 'someone-else', beforeTagNames: ['lk:reports'], afterTagNames: [] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).not.toHaveBeenCalled();
  });

  it('records one event per lake for a file that belongs to two of them', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      actor,
      [lake(), lake({ id: 'lake2', fileTagPrefix: 'lk:', datalakeTag: 'datalake:lake2' })],
      [file({ beforeTagNames: ['lk:reports'], afterTagNames: [] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls.map(([event]) => event.dataLakeId)).toEqual(['lake1', 'lake2']);
  });

  it('attaches the audit principal so a key-driven bulk write names the key', async () => {
    const { record, adapters } = audit();

    await recordMembershipTransitions(
      {
        userId,
        isAdmin: false,
        auditPrincipal: { principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: userId },
      },
      [lake()],
      [file({ beforeTagNames: ['lk:reports'], afterTagNames: [] })],
      adapters,
      { origin: 'person' }
    );

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ principalKind: 'apiKey', principalId: 'key-abc', onBehalfOfUserId: userId })
    );
  });

  it('is a silent no-op with no audit repository wired', async () => {
    await expect(
      recordMembershipTransitions(
        actor,
        [lake()],
        [file({ beforeTagNames: ['lk:reports'], afterTagNames: [] })],
        { db: {} },
        { origin: 'person' }
      )
    ).resolves.toBeUndefined();
  });

  // Best-effort like the recorder it wraps: the tag write has already landed, so one failed event
  // must neither throw nor cost the rest of the batch their rows.
  it('swallows a recorder failure and keeps recording the remaining pairs', async () => {
    const record = vi.fn().mockRejectedValueOnce(new Error('mongo down')).mockResolvedValue({});
    const logger = { error: vi.fn() };

    await recordMembershipTransitions(
      actor,
      [lake()],
      [
        file({ fabFileId: 'file1', beforeTagNames: ['lk:reports'], afterTagNames: [] }),
        file({ fabFileId: 'file2', beforeTagNames: ['lk:reports'], afterTagNames: [] }),
      ],
      { db: { lakeMembershipChangeEvents: { record } }, logger },
      { origin: 'person' }
    );

    expect(record).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
