export type LicenseKind = 'permissive' | 'restricted';

// The CLI keeps its own, wider list in packages/cli/src/models/localModels.ts.
const PERMISSIVE_LICENSES = new Set([
  'apache-2.0',
  'mit',
  'bsd',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd-3-clause-clear',
  'isc',
]);

/** Permissive only when every declared license is; none at all needs the user to accept the card's terms. */
export function licenseKind(licenses: readonly string[]): LicenseKind {
  return licenses.length > 0 && licenses.every(license => PERMISSIVE_LICENSES.has(license.trim().toLowerCase()))
    ? 'permissive'
    : 'restricted';
}
