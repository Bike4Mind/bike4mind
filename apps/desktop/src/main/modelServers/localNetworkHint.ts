import type { AddressScope } from '@bike4mind/local-models/servers';

/**
 * macOS asks before an app connects to a LAN address (NSLocalNetworkUsageDescription in
 * electron-builder.yml). Once the user declines, connects to private addresses fail at the socket and
 * macOS does not ask again, so the failure is the only signal. A declined permission fails with
 * EHOSTUNREACH (seen on macOS 26); ENETUNREACH is kept as the other no-route code.
 */
const DECLINED_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

// macOS files every ad-hoc-signed build under "Electron"; drop the parenthetical once builds are Developer ID signed.
export const LOCAL_NETWORK_HINT =
  'If macOS is blocking local network access, allow Bike4Mind (listed as "Electron" in beta builds) in System Settings > Privacy & Security > Local Network.';

/** The hint for a failed connection, or null when it cannot be the macOS Local Network permission. */
export function localNetworkHint(
  code: string | null | undefined,
  scope: AddressScope | null | undefined,
  platform: NodeJS.Platform = process.platform
): string | null {
  return platform === 'darwin' && scope === 'private' && !!code && DECLINED_CODES.has(code) ? LOCAL_NETWORK_HINT : null;
}

/** `message` with the hint appended when it applies. */
export function withLocalNetworkHint(
  message: string,
  code: string | null | undefined,
  scope: AddressScope | null | undefined,
  platform: NodeJS.Platform = process.platform
): string {
  const hint = localNetworkHint(code, scope, platform);
  if (!hint) return message;
  // Failure reasons such as "Could not reach host: no route to the host" carry no closing period.
  return /[.!?]$/.test(message) ? `${message} ${hint}` : `${message}. ${hint}`;
}
