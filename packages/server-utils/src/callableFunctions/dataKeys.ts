// Object keys in the function-data bucket (infra/callableFunctionData.ts). Imports nothing, like runtimeLimits.ts.

const PREFIX = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `data/<prefix>/<sha256>`: the tenant or function prefix comes before the hash so a signed link for one tenant's file
 * never names another tenant's object, even for identical bytes. The runtime's S3 endpoint reads only under `data/`
 * (FUNCTION_DATA_KEY_PREFIX in infra/callableFunctionNetwork.ts), which leaves other top-level segments free.
 */
export function callableFunctionDataKey(prefix: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('A function-data hash is 64 lowercase hex characters.');
  return `${callableFunctionDataPrefix(prefix)}${sha256}`;
}

/** `data/<prefix>/staging/<id>`: one pin's upload before its hash is known; inside the prefix, so a prefix delete takes it. */
export function callableFunctionDataStagingKey(prefix: string, id: string): string {
  if (!PREFIX.test(id)) throw new Error('A staging id is 1 to 128 letters, digits, "_", or "-".');
  return `${callableFunctionDataPrefix(prefix)}staging/${id}`;
}

/** `data/<prefix>/`: every object of one tenant or function, for a delete by prefix. */
export function callableFunctionDataPrefix(prefix: string): string {
  if (!PREFIX.test(prefix)) throw new Error('A function-data prefix is 1 to 128 letters, digits, "_", or "-".');
  return `data/${prefix}/`;
}

// A bucket lifecycle rule expires these after a day (FUNCTION_LIVE_SOURCE_KEY_PREFIX, infra/callableFunctionNetwork.ts).
// The dot is outside PREFIX, so no `data/<prefix>/` can name this segment.
export const CALLABLE_FUNCTION_LIVE_SOURCE_KEY_PREFIX = 'data/.live/';

/** `data/.live/<functionId>/`: every live source fetch of one function. */
export function callableFunctionLiveSourcePrefix(functionId: string): string {
  return `${CALLABLE_FUNCTION_LIVE_SOURCE_KEY_PREFIX}${callableFunctionDataPrefix(functionId).slice('data/'.length)}`;
}

/** `data/.live/<functionId>/<sha256>`: the bytes one live source fetch returned, for that call's signed link. */
export function callableFunctionLiveSourceKey(functionId: string, sha256: string): string {
  if (!SHA256.test(sha256)) throw new Error('A function-data hash is 64 lowercase hex characters.');
  return `${callableFunctionLiveSourcePrefix(functionId)}${sha256}`;
}
