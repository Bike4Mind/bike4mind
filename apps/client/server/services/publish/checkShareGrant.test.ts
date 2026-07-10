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
