/**
 * Known first-party clients for the OAuth 2.0 device authorization flow
 * (RFC 8628). `client_id` is an allowlist gate, not free input: the device
 * routes (apps/client/pages/api/oauth/device/*, oauth/refresh.ts) all parse it
 * against this list, so a client absent here cannot authenticate at all.
 *
 * Must stay in sync with the id each client actually sends. The one client that
 * lives in this repo is packages/cli/src/auth/OAuthClient.ts, which types its
 * own id as OAuthDeviceClientId so a rename here fails its build; clients kept
 * outside this repo have no such check, so removing an id here locks them out.
 */
export const OAUTH_DEVICE_CLIENT_IDS = ['b4m-cli', 'b4m-desktop'] as const;

export type OAuthDeviceClientId = (typeof OAUTH_DEVICE_CLIENT_IDS)[number];

/**
 * How a DeviceAuthorization row created before `clientId` was persisted must be
 * read. The CLI was the only client that existed then, and such rows expire
 * within the 10-minute TTL of the deploy that added the field.
 */
export const LEGACY_DEVICE_CLIENT_ID: OAuthDeviceClientId = 'b4m-cli';

const DISPLAY_NAMES: Record<OAuthDeviceClientId, string> = {
  'b4m-cli': 'B4M CLI',
  'b4m-desktop': 'B4M Desktop',
};

/**
 * What the browser approval screen calls a client. A raw slug is not consent
 * copy: the user is being asked to trust this thing by name. Unknown ids fall
 * through to the slug rather than a guess.
 */
export function oauthClientDisplayName(clientId: string): string {
  return DISPLAY_NAMES[clientId as OAuthDeviceClientId] ?? clientId;
}

const MAX_SOURCE_SLUG_LENGTH = 64;
const OAUTH_CLIENT_ID_SHAPE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Whether a caller-supplied value can be an OAuth client id. Ids are logged on the
 * attribution path, so anything outside this charset (CR/LF included) is refused outright.
 */
export function isOAuthClientIdShape(value: unknown): value is string {
  return typeof value === 'string' && OAUTH_CLIENT_ID_SHAPE.test(value);
}

/**
 * The attribution slug for a registered OAuth client, used as the `source:<slug>` user tag.
 * Recovered from the id minted by generateOAuthClientId
 * (packages/database/src/models/auth/oauthClientAdmin.ts), whose b4m_<slug>_<8 hex> shape
 * must stay in sync with the pattern here. Two clients registered under the same name share a slug.
 */
export function oauthClientSourceSlug(clientId: string): string {
  const minted = /^b4m_(.+)_[0-9a-f]{8}$/.exec(clientId);
  if (minted) return minted[1];
  return clientId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, MAX_SOURCE_SLUG_LENGTH);
}

/**
 * The client_id of an in-app /oauth/authorize return path, or undefined for anything else.
 * Only a same-origin relative path is accepted, so an absolute or protocol-relative
 * redirectTo never yields an id.
 */
export function clientIdFromAuthorizeRedirect(redirectTo: unknown): string | undefined {
  if (typeof redirectTo !== 'string' || !redirectTo.startsWith('/') || redirectTo.startsWith('//')) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(redirectTo, 'http://local');
  } catch {
    return undefined;
  }
  if (url.origin !== 'http://local' || url.pathname !== '/oauth/authorize') return undefined;
  const ids = url.searchParams.getAll('client_id');
  if (ids.length !== 1) return undefined;
  const [id] = ids;
  return isOAuthClientIdShape(id) ? id : undefined;
}
