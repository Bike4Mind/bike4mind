import { describe, expect, it } from 'vitest';
import { storageOwnerOf, sumStorageDeltaByOwner, type StorageOwner } from './storageOwner';

const user: StorageOwner = { type: 'user', id: 'user-1' };
const org: StorageOwner = { type: 'org', id: 'org-1' };

describe('storageOwnerOf', () => {
  it('bills an org-stamped row to the org, whoever uploaded it', () => {
    expect(storageOwnerOf({ userId: 'user-1', organizationId: 'org-1' })).toEqual(org);
  });

  it.each([undefined, null, ''])('bills a row with organizationId %j to its uploader', organizationId => {
    expect(storageOwnerOf({ userId: 'user-1', organizationId })).toEqual(user);
  });
});

describe('sumStorageDeltaByOwner', () => {
  it('sums per owner without mixing a user and an org that share an id', () => {
    const sameIdOrg: StorageOwner = { type: 'org', id: 'user-1' };
    expect(
      sumStorageDeltaByOwner([
        { owner: user, bytes: -10 },
        { owner: sameIdOrg, bytes: -5 },
        { owner: user, bytes: -20 },
      ])
    ).toEqual([
      { owner: user, bytes: -30 },
      { owner: sameIdOrg, bytes: -5 },
    ]);
  });

  it('drops owners whose deltas cancel out or are zero', () => {
    expect(
      sumStorageDeltaByOwner([
        { owner: user, bytes: 7 },
        { owner: user, bytes: -7 },
        { owner: org, bytes: 0 },
      ])
    ).toEqual([]);
  });
});
