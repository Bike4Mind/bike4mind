/**
 * 401s whose body says the Bike4Mind credential WAS accepted, so refreshing it or signing in
 * again cannot help: a missing or refused AI-provider key, and a session that still owes its
 * second factor. Keep the provider codes in sync with packages/cli/src/auth/providerKeyFailure.ts.
 */
const CREDENTIAL_ACCEPTED_CODES: ReadonlySet<string> = new Set(['provider_not_configured', 'provider_rejected']);

/** For the shared client's `isPassThrough401`: true leaves the 401 to its caller as an ordinary error. */
export function isCredentialAccepted401(data: unknown): boolean {
  const body = decodeBody(data);
  if (!body || typeof body !== 'object') return false;
  const { errorCode, mfaPending } = body as Record<string, unknown>;
  return mfaPending === true || (typeof errorCode === 'string' && CREDENTIAL_ACCEPTED_CODES.has(errorCode));
}

/** A streamed request's body reaches here as the string the shared client buffered it into. */
function decodeBody(data: unknown): unknown {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  else return data;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
