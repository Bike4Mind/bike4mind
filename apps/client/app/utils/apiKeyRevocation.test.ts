import { describe, it, expect } from 'vitest';
import { revocationTooltip } from './apiKeyRevocation';

describe('revocationTooltip', () => {
  it('returns null for a key with no revocation timestamp', () => {
    expect(revocationTooltip({})).toBeNull();
  });

  it('renders relative and absolute time for a revoked key', () => {
    const tooltip = revocationTooltip({ revokedAt: new Date('2026-01-15T09:30:00Z') });

    expect(tooltip).toContain('Revoked');
    expect(tooltip).toContain('Jan 15, 2026');
  });

  it('appends the reason when one was recorded', () => {
    const tooltip = revocationTooltip({
      revokedAt: new Date('2026-01-15T09:30:00Z'),
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
