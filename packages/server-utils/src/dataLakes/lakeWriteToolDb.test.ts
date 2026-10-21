import { describe, expect, it } from 'vitest';
import { memoryLedgerRepository, lakeMembershipRemovalRepository } from '@bike4mind/database';
import { lakeConfigAuditDb } from './lakeConfigAuditDb';
import { lakeMembershipAuditDb } from './lakeMembershipAuditDb';
import { lakeWriteToolDb } from './lakeWriteToolDb';

describe('lakeWriteToolDb', () => {
  it('carries the real removal and audit repositories', () => {
    expect(lakeWriteToolDb).toEqual({
      memoryLedger: memoryLedgerRepository,
      lakeMembershipRemovals: lakeMembershipRemovalRepository,
      lakeConfigChangeEvents: lakeConfigAuditDb.lakeConfigChangeEvents,
      lakeMembershipChangeEvents: lakeMembershipAuditDb.lakeMembershipChangeEvents,
    });
    expect(Object.isFrozen(lakeWriteToolDb)).toBe(true);
  });
});
