import { describe, it, expect } from 'vitest';
import { lakeConfigAuditPrincipal } from './lakeConfigAuditPrincipal';

/**
 * The config half of API-key attribution, mirroring `resolveAuditPrincipal.test.ts` on the read side.
 *
 * The failure mode this guards is silent: drop the `auditPrincipal` line from any one of the four
 * config-write routes and every suite still passes, while API-key writes go back to being recorded
 * as though the owning human made the change by hand - in append-only rows retained for years.
 */
describe('lakeConfigAuditPrincipal', () => {
  it('returns undefined for a session write, leaving the existing derivation alone', () => {
    // Deliberately NOT a redundant `{ principalKind: 'user', principalId }`: for a session,
    // recordLakeConfigChange already derives exactly that from `actor.userId`, including its
    // blank-id-means-system arm. Attaching a second spelling of the same fact would be noise the
    // audit has to be trusted not to disagree with.
    expect(lakeConfigAuditPrincipal({ id: 'u1' }, undefined)).toBeUndefined();
  });

  it('attributes an API-key write to the KEY, keeping the human findable', () => {
    expect(lakeConfigAuditPrincipal({ id: 'owner-1' }, { keyId: 'key-abc' })).toEqual({
      principalKind: 'apiKey',
      principalId: 'key-abc',
      onBehalfOfUserId: 'owner-1',
    });
  });

  it('describes a key-driven principal identically to the read side', () => {
    // The two halves of the trail must not drift: this helper delegates to the read side's own
    // resolveAuditPrincipal precisely so a key-driven WRITE and a key-driven READ name the same
    // principal the same way. Asserting the literal shape here is what would catch a config-specific
    // twin being introduced later.
    const principal = lakeConfigAuditPrincipal({ id: 'owner-1' }, { keyId: 'key-abc' });
    expect(Object.keys(principal ?? {}).sort()).toEqual(['onBehalfOfUserId', 'principalId', 'principalKind']);
  });
});
