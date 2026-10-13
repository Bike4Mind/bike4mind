import { describe, expect, it } from 'vitest';
import { lakeMembershipRemovalRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { lakeWriteToolDb } from '@server/dataLakes/lakeWriteToolDb';

describe('lakeWriteToolDb', () => {
  it('carries the real removal and audit repositories', () => {
    expect(lakeWriteToolDb).toEqual({
      lakeMembershipRemovals: lakeMembershipRemovalRepository,
      lakeConfigChangeEvents: lakeConfigAuditDb.lakeConfigChangeEvents,
      lakeMembershipChangeEvents: lakeMembershipAuditDb.lakeMembershipChangeEvents,
    });
    expect(Object.isFrozen(lakeWriteToolDb)).toBe(true);
  });
});
