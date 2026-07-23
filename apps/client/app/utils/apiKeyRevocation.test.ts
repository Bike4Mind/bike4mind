import { describe, it, expect } from 'vitest';
import { revocationTooltip } from './apiKeyRevocation';

// Built from local-time components, not a 'Z' string: the helper formats in local
// time, so a UTC fixture would render a different calendar day either side of the
// date line and the assertion below would depend on the host timezone.
const REVOKED_AT = new Date(2026, 0, 15, 9, 30);

describe('revocationTooltip', () => {
  it('returns null for a key with no revocation timestamp', () => {
    expect(revocationTooltip({})).toBeNull();
  });

  it('renders relative and absolute time for a revoked key', () => {
    const tooltip = revocationTooltip({ revokedAt: REVOKED_AT });

    expect(tooltip).toContain('Revoked');
    expect(tooltip).toContain('Jan 15, 2026 9:30 AM');
  });

  // What the client actually receives: the API serializes revokedAt to JSON, so
  // prod passes an ISO string here even though IUserApiKey types it as a Date.
  it('accepts an ISO string as it arrives over the wire', () => {
    const tooltip = revocationTooltip({ revokedAt: REVOKED_AT.toISOString() });

    expect(tooltip).toContain('Jan 15, 2026 9:30 AM');
  });

  it('appends the reason when one was recorded', () => {
    const tooltip = revocationTooltip({
      revokedAt: REVOKED_AT,
      revokedReason: 'Superseded by a new federated AI-token exchange',
    });

    expect(tooltip).toContain('Superseded by a new federated AI-token exchange');
  });

  // A reason without a timestamp cannot be rendered as "Revoked <when>", so the
  // whole tooltip is suppressed rather than showing a dangling reason.
  it('stays null when a reason exists but the timestamp does not', () => {
    expect(revocationTooltip({ revokedReason: 'Revoked by admin' })).toBeNull();
  });
});
