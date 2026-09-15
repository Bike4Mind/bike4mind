import { describe, it, expect } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { refuseGrantWrite, refuseOwnerGrantChange } from './lakeGrantWriteRule';

const lake = (organizationId?: string): Pick<IDataLakeDocument, 'organizationId'> =>
  ({ organizationId }) as Pick<IDataLakeDocument, 'organizationId'>;

describe('refuseGrantWrite', () => {
  it('admits a reader and a curator on a user principal, cross-org included', () => {
    // The headline case: a user who belongs to no organization of the lake's. Deliberately NOT
    // org-checked - only the org arm is contained.
    expect(
      refuseGrantWrite(lake('org1'), { principalType: 'user', principalId: 'outsider', role: 'reader' })
    ).toBeNull();
    expect(refuseGrantWrite(lake('org1'), { principalType: 'user', principalId: 'u2', role: 'curator' })).toBeNull();
  });

  it('refuses an owner grant on both principal types, pointing at transfer', () => {
    // A curator passes canManageLake, so without this they could grant themselves ownership and
    // route around the transfer authority ladder and its consent guard.
    expect(refuseGrantWrite(lake('org1'), { principalType: 'user', principalId: 'u1', role: 'owner' })).toMatch(
      /transfer ownership/i
    );
    expect(
      refuseGrantWrite(lake('org1'), { principalType: 'organization', principalId: 'org1', role: 'owner' })
    ).toMatch(/transfer ownership/i);
  });

  it('admits an org grant only for the lake OWN org', () => {
    expect(
      refuseGrantWrite(lake('org1'), { principalType: 'organization', principalId: 'org1', role: 'reader' })
    ).toBeNull();
    // The cross-org containment (epic decision 12) that resolveReadGrant delegates entirely to this
    // rule: the read arm honors an org grant with no same-org check of its own.
    expect(
      refuseGrantWrite(lake('org1'), { principalType: 'organization', principalId: 'org2', role: 'reader' })
    ).toMatch(/organization that owns it/i);
  });

  it('refuses an org CURATOR grant: no principal exists that it could confer management on', () => {
    // The only grantable org is the lake's own, and canManageLake's org-grant rung fires only for an
    // org the actor administers - who already manage the lake by the rung above it. So the grant
    // would change nobody's capability while auditing as though org-wide management was handed out.
    expect(
      refuseGrantWrite(lake('org1'), { principalType: 'organization', principalId: 'org1', role: 'curator' })
    ).toMatch(/only be granted reader access/i);
  });

  it('refuses every org grant on a personal lake', () => {
    expect(
      refuseGrantWrite(lake(undefined), { principalType: 'organization', principalId: 'org1', role: 'reader' })
    ).toMatch(/belongs to no organization/i);
  });

  it('matches an ObjectId-shaped organizationId through normalizeId', () => {
    const objectIdish = { toHexString: () => 'org1' } as unknown as string;
    expect(
      refuseGrantWrite({ organizationId: objectIdish } as Pick<IDataLakeDocument, 'organizationId'>, {
        principalType: 'organization',
        principalId: 'org1',
        role: 'reader',
      })
    ).toBeNull();
  });

  it('refuses a blank principal', () => {
    expect(refuseGrantWrite(lake('org1'), { principalType: 'user', principalId: '', role: 'reader' })).toMatch(
      /must name a principal/i
    );
  });

  it('refuses an expiry that has already passed', () => {
    const now = new Date('2026-01-10T00:00:00Z');
    const input = { principalType: 'user' as const, principalId: 'u1', role: 'reader' as const };
    // A lapsed row is filtered out of every active read the moment it lands, so writing one would
    // look like a silent no-op rather than a mistake.
    expect(refuseGrantWrite(lake('org1'), { ...input, expiresAt: new Date('2026-01-09T00:00:00Z') }, now)).toMatch(
      /expire in the past/i
    );
    expect(refuseGrantWrite(lake('org1'), { ...input, expiresAt: new Date('2026-01-11T00:00:00Z') }, now)).toBeNull();
    expect(refuseGrantWrite(lake('org1'), { ...input, expiresAt: null }, now)).toBeNull();
  });
});

describe('refuseOwnerGrantChange', () => {
  it('refuses touching an ownership grant, which would silently un-transfer the lake', () => {
    // Covers BOTH doors: a revoke, and a re-role down to curator that refuseGrantWrite cannot see
    // because the role it is handed is a perfectly legal 'curator'.
    expect(refuseOwnerGrantChange({ role: 'owner' })).toMatch(/transfer ownership/i);
  });

  it('admits touching a curator or reader row, and a principal with no row at all', () => {
    expect(refuseOwnerGrantChange({ role: 'curator' })).toBeNull();
    expect(refuseOwnerGrantChange({ role: 'reader' })).toBeNull();
    expect(refuseOwnerGrantChange(null)).toBeNull();
  });
});
