import { OAUTH_SOURCE_TAG_PREFIX, isOAuthClientIdShape, oauthClientSourceSlug } from '@bike4mind/common';

/** Narrow client lookup, so this package stays free of @bike4mind/database. */
export interface OAuthSourceClientLookup {
  findByClientId(clientId: string): Promise<{ clientId: string; isActive: boolean } | null>;
}

/**
 * The stored clientId of the active registered OAuth client a signup named, or null. The returned
 * id comes from the client record, never from the request.
 */
export async function resolveActiveOAuthClientId(
  clientId: unknown,
  lookup: OAuthSourceClientLookup
): Promise<string | null> {
  if (!isOAuthClientIdShape(clientId)) return null;
  const client = await lookup.findByClientId(clientId);
  return client && client.isActive === true ? client.clientId : null;
}

/** The `source:<slug>` tag for a resolved client id (resolveActiveOAuthClientId), or null. */
export function oauthSourceTagFor(clientId: string): string | null {
  const slug = oauthClientSourceSlug(clientId);
  return slug ? `${OAUTH_SOURCE_TAG_PREFIX}${slug}` : null;
}

/**
 * The `source:<slug>` tag for a signup that came through a registered OAuth client, or null.
 * The slug is derived from the stored client record, never from the request, and only an
 * active client yields one.
 */
export async function resolveOAuthSourceTag(
  clientId: unknown,
  lookup: OAuthSourceClientLookup
): Promise<string | null> {
  const activeClientId = await resolveActiveOAuthClientId(clientId, lookup);
  return activeClientId ? oauthSourceTagFor(activeClientId) : null;
}
