// Object keys in the function-data bucket (infra/callableFunctionData.ts). Imports nothing, like runtimeLimits.ts.

const PREFIX = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `<prefix>/<sha256>`: the tenant or function prefix comes first so a signed link for one tenant's file never
 * names another tenant's object, even for identical bytes.
 */
export function callableFunctionDataKey(prefix: string, sha256: string): string {
  if (!PREFIX.test(prefix)) throw new Error('A function-data prefix is 1 to 128 letters, digits, "_", or "-".');
  if (!SHA256.test(sha256)) throw new Error('A function-data hash is 64 lowercase hex characters.');
  return `${prefix}/${sha256}`;
}
