import { describe, it, expect, vi } from 'vitest';
import type { IInviteDocument } from '@bike4mind/common';
import { resolveAddressedInvite, resolveRedeemableInvite } from './resolveRedeemableInvite';

const LEGACY_ID = '65a1f77bcf86cd7994390001';
const TOKENIZED_ID = '65a1f77bcf86cd7994390002';
const TOKEN = 'wVvJ0hEr1sKq7nQ9YpB2fL4dXz8TcMuGaSiN3ROZjkw';

/** Link invite by default - names nobody, so holding the key is the whole authorization. */
const invite = (overrides: Partial<IInviteDocument> = {}): IInviteDocument =>
  ({
    id: LEGACY_ID,
    type: 'FabFile',
    documentId: 'doc1',
    accepted: 0,
    remaining: 1,
    isLinkOnly: true,
    ...overrides,
  }) as IInviteDocument;

/** Named invite: every door re-checks the caller's email or share authority independently. */
const namedInvite = (overrides: Partial<IInviteDocument> = {}): IInviteDocument =>
  invite({
    isLinkOnly: false,
    recipients: { pending: ['recipient@x.com'], accepted: [], refused: [] },
    ...overrides,
  });

/** Rows keyed both ways, so the fake answers exactly as the real repo would for each door. */
const dbOf = (rows: IInviteDocument[]) => {
  const findByToken = vi.fn(async (token: string) => rows.find(r => !!r.token && r.token === token) ?? null);
  const findById = vi.fn(async (id: string) => rows.find(r => r.id === id) ?? null);
  return { db: { invites: { findByToken, findById } }, findByToken, findById };
};

describe('resolveRedeemableInvite - the share link bearer secret', () => {
  it('resolves a tokenized invite by its token', async () => {
    const row = invite({ id: TOKENIZED_ID, token: TOKEN });
    const { db } = dbOf([row]);

    await expect(resolveRedeemableInvite(TOKEN, { db })).resolves.toMatchObject({ id: TOKENIZED_ID });
  });

  // The finding itself. The row exists and the caller named it correctly; it still must not resolve,
  // because an ObjectId is only partially random and is disclosed by every surface that lists
  // invites - which is exactly what made neighbouring ids worth enumerating.
  it('refuses a tokenized invite addressed by its _id, even though the row exists', async () => {
    const row = invite({ id: TOKENIZED_ID, token: TOKEN });
    const { db, findById } = dbOf([row]);

    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db })).resolves.toBeNull();
    // Found, then deliberately discarded - the refusal is the token check, not a failed lookup.
    expect(findById).toHaveBeenCalledWith(TOKENIZED_ID);
  });

  // The other half of the chosen migration path: links already sitting in inboxes keep working.
  it('still resolves a legacy tokenless invite by its _id', async () => {
    const { db } = dbOf([invite({ id: LEGACY_ID })]);

    await expect(resolveRedeemableInvite(LEGACY_ID, { db })).resolves.toMatchObject({ id: LEGACY_ID });
  });

  it('returns null for an unknown token and an unknown id', async () => {
    const { db } = dbOf([invite({ id: LEGACY_ID })]);

    await expect(resolveRedeemableInvite('not-a-real-token-value-here-0000000000000', { db })).resolves.toBeNull();
    await expect(resolveRedeemableInvite('65a1f77bcf86cd7994390999', { db })).resolves.toBeNull();
  });

  // findById CASTS rather than missing, so an unguarded fallback would turn every token lookup miss
  // into a 500 instead of the 404 each redemption path is careful to return.
  it('never probes the id door with a key that could not be an ObjectId', async () => {
    const { db, findById } = dbOf([invite({ id: LEGACY_ID })]);

    await expect(resolveRedeemableInvite(TOKEN, { db })).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('resolves nothing for an empty key without touching either door', async () => {
    const { db, findByToken, findById } = dbOf([invite({ id: LEGACY_ID })]);

    await expect(resolveRedeemableInvite('', { db })).resolves.toBeNull();
    expect(findByToken).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  // A tokenless row must not be reachable by passing '' (or anything falsy) as a token: `token` is
  // sparse, so a careless equality query would match every legacy invite at once.
  it('does not let an empty token match a tokenless invite', async () => {
    const { db } = dbOf([invite({ id: LEGACY_ID, token: undefined })]);

    await expect(resolveRedeemableInvite('', { db })).resolves.toBeNull();
  });

  // The id door closes for a LINK invite because nothing else gates it. A named invite re-checks
  // the caller's email (accept, refuse's decline arm) or share authority (refuse's revoke arm, the
  // landing GET), so its id is an address rather than a secret - and the inbox, which lists invites
  // through a projection carrying no token, has no other key to address them with.
  it('still resolves a tokenized NAMED invite by its _id, which is all the inbox has', async () => {
    const row = namedInvite({ id: TOKENIZED_ID, token: TOKEN });
    const { db } = dbOf([row]);

    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db })).resolves.toMatchObject({ id: TOKENIZED_ID });
    await expect(resolveRedeemableInvite(TOKEN, { db })).resolves.toMatchObject({ id: TOKENIZED_ID });
  });

  // The pair that makes the distinction load-bearing: same row, same token, same id, and the only
  // difference is whether anyone is named on it.
  it('keys the id door on whether the invite names anyone, not on having a token', async () => {
    const link = dbOf([invite({ id: TOKENIZED_ID, token: TOKEN })]);
    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db: link.db })).resolves.toBeNull();

    const named = dbOf([namedInvite({ id: TOKENIZED_ID, token: TOKEN })]);
    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db: named.db })).resolves.not.toBeNull();
  });

  // Rows minted before `isLinkOnly` existed carry no flag; isLinkOnlyInvite infers from the absence
  // of named recipients, so a legacy link invite is still treated as one.
  it('infers link-only for a row minted before the flag existed', async () => {
    const legacyShape = {
      id: TOKENIZED_ID,
      token: TOKEN,
      type: 'FabFile',
      documentId: 'doc1',
      accepted: 0,
      remaining: 1,
      recipients: { pending: [], accepted: [], refused: [] },
    } as unknown as IInviteDocument;
    const { db } = dbOf([legacyShape]);

    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db })).resolves.toBeNull();
  });

  // The legacy population can only shrink. Once a row has a token there is no key that reaches it
  // except that token, so the weak door cannot reopen for an invite that has already crossed over.
  it('closes the id door permanently once a row gains a token', async () => {
    const rows = [invite({ id: LEGACY_ID })];
    const { db } = dbOf(rows);
    await expect(resolveRedeemableInvite(LEGACY_ID, { db })).resolves.toMatchObject({ id: LEGACY_ID });

    rows[0].token = TOKEN;
    await expect(resolveRedeemableInvite(LEGACY_ID, { db })).resolves.toBeNull();
    await expect(resolveRedeemableInvite(TOKEN, { db })).resolves.toMatchObject({ id: LEGACY_ID });
  });
});

describe('resolveAddressedInvite - the same lookup without the bearer semantics', () => {
  // refuseWholeInvite's door. Both arms behind it re-derive authority from the caller, so the key is
  // an address and the sharer revoking their own link invite from the document's invite list - which
  // knows only the _id - must not be turned away.
  it('resolves a tokenized LINK invite by its _id, which the redeemable door refuses', async () => {
    const row = invite({ id: TOKENIZED_ID, token: TOKEN });
    const { db } = dbOf([row]);

    await expect(resolveAddressedInvite(TOKENIZED_ID, { db })).resolves.toMatchObject({ id: TOKENIZED_ID });
    await expect(resolveRedeemableInvite(TOKENIZED_ID, { db })).resolves.toBeNull();
  });

  it('still prefers the token, and still shape-guards the id door', async () => {
    const { db, findById } = dbOf([invite({ id: TOKENIZED_ID, token: TOKEN })]);

    await expect(resolveAddressedInvite(TOKEN, { db })).resolves.toMatchObject({ id: TOKENIZED_ID });
    expect(findById).not.toHaveBeenCalled();

    await expect(resolveAddressedInvite('not-a-real-token-value-here-0000000000000', { db })).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('resolves nothing for an empty key or an unknown id', async () => {
    const { db, findByToken } = dbOf([invite({ id: LEGACY_ID })]);

    await expect(resolveAddressedInvite('', { db })).resolves.toBeNull();
    expect(findByToken).not.toHaveBeenCalled();
    await expect(resolveAddressedInvite('65a1f77bcf86cd7994390999', { db })).resolves.toBeNull();
  });
});
