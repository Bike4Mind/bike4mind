const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function parseSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Reads the `id` claim without verifying the signature; '' when the token is malformed or has no string id. */
export function decodeJwtUserId(token: string): string {
  if (!JWT_SHAPE.test(token)) return '';
  const [header, payload] = token.split('.');
  try {
    if (!parseSegment(header)) return '';
    const claims = parseSegment(payload);
    const id = claims !== null && typeof claims === 'object' ? (claims as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}
