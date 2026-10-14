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
