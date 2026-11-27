import { describe, expect, it } from 'vitest';
import { bulkAbuseActionPermissions, type BulkAbuseActions } from './bulkAbuse';

const actions = (overrides: Partial<BulkAbuseActions>): BulkAbuseActions => ({
  ban: false,
  revokeApiKeys: false,
  revokeSessions: false,
  clawbackFreeCredits: false,
  ...overrides,
});

describe('bulkAbuseActionPermissions', () => {
  it('names each selected action permission once', () => {
    expect(bulkAbuseActionPermissions(actions({ revokeSessions: true, clawbackFreeCredits: true }))).toEqual([
      'users:moderate',
      'credits:adjust',
    ]);
  });

  it('needs keys:revoke for a key revocation on its own', () => {
    expect(bulkAbuseActionPermissions(actions({ revokeApiKeys: true }))).toEqual(['keys:revoke']);
  });

  it('lets a ban cover the key revocation it always performs', () => {
    expect(bulkAbuseActionPermissions(actions({ ban: true, revokeApiKeys: true }))).toEqual(['users:moderate']);
  });
});
