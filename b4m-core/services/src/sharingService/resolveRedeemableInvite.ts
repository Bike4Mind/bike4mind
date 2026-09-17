import { IInviteDocument, isLinkOnlyInvite, isObjectIdShaped } from '@bike4mind/common';

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
 * Resolve the invite a redemption key addresses, for the paths that take a key off a share URL:
 * the landing GET, accept, and refuse.
 *
 * The token always resolves. Whether the `_id` ALSO resolves turns on whether the key is acting as
 * a credential, which depends on the kind of invite:
 *
 * - A LINK invite names nobody, so holding the key is the entire authorization and nothing else
 *   gates it. That is the one case finding 169 is about, and there a tokenized invite is refused by
 *   `_id` even though the row exists. An ObjectId is only partially random and is disclosed by every
 *   surface that lists invites, so it cannot be the secret.
 * - A NAMED invite re-checks the caller's identity independently at every door: accept requires the
 *   caller's email in `recipients.pending`, refuse's decline arm requires the same, and refuse's
 *   revoke arm and the landing GET require share authority on the underlying document. The key is an
 *   ADDRESS there, not a secret, so both forms resolve. This is not a concession: the inbox lists
 *   invites through `findAllByPendingUserIdOrEmail`, whose projection carries no token, so the `_id`
 *   is the only key that surface has. Closing it would 404 every inbox accept and decline.
 *
 * The legacy arm is keyed on the ABSENCE of a token rather than a cutover timestamp: the row
 * describes its own era, so there is no clock constant to keep correct, no skew at the boundary, and
 * no way for the door to widen back open once a row has a token. That population only ever shrinks -
 * it cannot be added to, since every mint now issues a token - and expiry is what finally empties it
 * (see the expiry cap migration, and the `expiresAt` check every caller applies).
 *
 * Returns null rather than throwing so each caller keeps its own not-found shape; every one of them
 * answers an unresolvable key with a 404 rather than a 403, so probing cannot confirm an id exists.
 */
export const resolveRedeemableInvite = async (
  key: string,
  adapters: RedeemableInviteAdapters
): Promise<IInviteDocument | null> => {
  const invite = await resolveAddressedInvite(key, adapters);
  if (!invite) return null;

  // The whole point, scoped to where the key is the only thing standing between a caller and the
  // grant: a tokenized LINK invite reached by anything other than its own token. `isLinkOnlyInvite`
  // carries the legacy inference for rows minted before the flag existed.
  return invite.token && invite.token !== key && isLinkOnlyInvite(invite) ? null : invite;
};

/**
 * The same lookup with NO bearer semantics: the token and the `_id` both resolve, for every kind of
 * invite. For the paths that authorize the caller independently of the key, where the key is only an
 * address - `refuseWholeInvite`, whose decline arm demands the caller's own email in
 * `recipients.pending` and whose revoke arm demands share authority on the underlying document
 * (`cancelInviteById` resolves the same way, by plain `findById`).
 *
 * Do not reach for this on a redemption path. The narrowing in `resolveRedeemableInvite` is the
 * finding, not an incidental strictness, and a caller that grants on the strength of the key alone
 * must go through that door instead.
 */
export const resolveAddressedInvite = async (
  key: string,
  { db }: RedeemableInviteAdapters
): Promise<IInviteDocument | null> => {
  if (!key) return null;

  const byToken = await db.invites.findByToken(key);
  if (byToken) return byToken;

  // Guarded: findById CASTS, so a token-shaped key reaching it throws instead of missing.
  if (!isObjectIdShaped(key)) return null;

  return db.invites.findById(key);
};
