import { describe, it, expect } from 'vitest';
import { resolveAuditPrincipal } from './resolveAuditPrincipal';

describe('resolveAuditPrincipal', () => {
  it('records the session user when there is no API key', () => {
    expect(resolveAuditPrincipal({ id: 'u1' }, undefined)).toEqual({
      principalKind: 'user',
      principalId: 'u1',
    });
  });

  // baseApi() accepts both a session and a b4m_live_ API key on these routes - an API-key read
  // must be recorded under the KEY's identity, not the human owner's, or every API-key read
  // before this fix (and after, if this regresses) is permanently indistinguishable in an
  // immutable, 450-day-floor audit trail from an in-app human read.
  it('records the KEY as principal and preserves the human owner separately when authenticated by API key', () => {
    expect(resolveAuditPrincipal({ id: 'owner-1' }, { keyId: 'key-abc' })).toEqual({
      principalKind: 'apiKey',
      principalId: 'key-abc',
      onBehalfOfUserId: 'owner-1',
    });
  });
});
