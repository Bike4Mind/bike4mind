import { IInviteDocument, isObjectIdShaped } from '@bike4mind/common';

/** The invite reads a redemption needs. Narrow so a route can pass its own repo without widening. */
export interface RedeemableInviteAdapters {
  db: {
    invites: {
      findByToken: (token: string) => Promise<IInviteDocument | null>;
      findById: (id: string) => Promise<IInviteDocument | null>;
    };
  };
}

/**
 * Resolve the invite a redemption key addresses, for every path where holding the key IS the
 * authorization: the share-link landing GET, and accept.
 *
 * Two doors, and the second one is closing. An invite minted since the token cutover is addressable
 * ONLY by its token; its `_id` no longer resolves here. An invite minted before carries no token and
 * is still addressable by `_id`, because the links are already sitting in people's inboxes and
 * breaking them would strand every unredeemed share.
 *
 * Keyed on the ABSENCE of a token rather than a cutover timestamp deliberately: the row describes
 * its own era, so there is no clock constant to keep correct, no skew at the boundary, and no way
 * for the legacy door to widen back open once a row has a token. The legacy population only ever
 * shrinks - it cannot be added to, since every mint now issues a token - and expiry is what finally
 * empties it (see the expiry cap migration, and the `expiresAt` check every caller applies).
 *
 * Returns null rather than throwing so each caller keeps its own not-found shape; every one of them
 * answers an unresolvable key with a 404 rather than a 403, so probing cannot confirm an id exists.
 */
export const resolveRedeemableInvite = async (
  key: string,
  { db }: RedeemableInviteAdapters
): Promise<IInviteDocument | null> => {
  if (!key) return null;

  const byToken = await db.invites.findByToken(key);
  if (byToken) return byToken;

  // Guarded: findById CASTS, so a token-shaped key reaching it throws instead of missing.
  if (!isObjectIdShaped(key)) return null;

  const byId = await db.invites.findById(key);
  if (!byId) return null;

  // The whole point. A tokenized invite presented by its id is refused even though the row exists,
  // so the id stops being a credential the moment the invite has a real one.
  return byId.token ? null : byId;
};
