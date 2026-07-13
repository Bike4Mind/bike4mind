import { describe, it, expect } from 'vitest';
import { checkShareGrant } from './checkShareGrant';

describe('checkShareGrant (Tier 1: token possession = read)', () => {
  it('grants read on a resolved token hit, regardless of visibility or caller', async () => {
    expect(await checkShareGrant({ ownerId: 'owner1' }, {})).toEqual({ ok: true });
  });

  it('grants read even for an anonymous caller (no user in context)', async () => {
    expect(await checkShareGrant({ ownerId: 'owner1' }, { user: undefined })).toEqual({ ok: true });
  });
});

// -- Tiers 2+3 (issue #383): accessGate layered on top of token possession -----
import { vi } from 'vitest';

vi.mock('@bike4mind/database', () => ({
  User: {
    findById: () => ({
      select: () => ({ lean: () => Promise.resolve({ email: 'jo@acme.com', emailVerified: true }) }),
    }),
  },
}));

describe('checkShareGrant - passphrase gate on a token link', () => {
  const gated = { ownerId: 'owner1', accessGate: { kind: 'passphrase' as const } };

  it('token alone is NOT enough once a passphrase gate is set', async () => {
    expect(await checkShareGrant(gated, {})).toMatchObject({ ok: false, status: 401, reason: 'passphrase' });
  });
  it('token + verified proof unlocks', async () => {
    expect(await checkShareGrant(gated, { passphraseVerified: true })).toEqual({ ok: true });
  });
  it('owner bypasses their own gate', async () => {
    expect(await checkShareGrant(gated, { user: { id: 'owner1' } })).toEqual({ ok: true });
  });
});

describe('checkShareGrant - domain gate on a token link', () => {
  const gated = { ownerId: 'owner1', accessGate: { kind: 'domain' as const, allowedDomains: ['acme.com'] } };

  it('anonymous token holder must sign in (401 + reason domain)', async () => {
    expect(await checkShareGrant(gated, {})).toMatchObject({ ok: false, status: 401, reason: 'domain' });
  });
  it('logged-in verified allowlisted domain unlocks', async () => {
    expect(await checkShareGrant(gated, { user: { id: 'viewer1' } })).toEqual({ ok: true });
  });
});
