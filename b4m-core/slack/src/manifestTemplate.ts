/**
 * Re-export from @bike4mind/common.
 *
 * The manifest template is pure config with zero runtime dependencies,
 * so it lives in common to be safely importable from client-side code
 * (e.g., CreateSlackAppModal). The slack package cannot be imported
 * client-side because it pulls in server-side deps (dns, sharp, fs).
 */
export {
  type ControlledManifestFields,
  type FullManifest,
  getControlledScopes,
  getControlledManifestFields,
  generateFullManifest,
} from '@bike4mind/common';
