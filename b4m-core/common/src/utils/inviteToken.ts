/**
 * The bearer secret carried by a share link, and the shape test that keeps the legacy `_id` door
 * from being probed with values that were never ids.
 */

/** Bytes of entropy per token. 32 bytes = 256 bits, well past guessing range for an online oracle. */
const INVITE_TOKEN_BYTES = 32;

/** A 24-character hex ObjectId, the only thing the legacy redemption door ever accepted. */
const OBJECT_ID_SHAPE = /^[0-9a-fA-F]{24}$/;

/**
 * Mint a share-link bearer token from the platform CSPRNG.
 *
 * base64url, so the value survives a URL path segment with no escaping and no '+'/'/' to be mangled
 * by a mail client rewriting the link. `globalThis.crypto` rather than node:crypto because this
 * module is in the shared common package, which the client bundles too; `getRandomValues` is the
 * CSPRNG on both sides. Deliberately NOT randomUUID: a v4 UUID carries 122 bits and spends 6 of its
 * characters on fixed version/variant nibbles and dashes.
 */
export function generateInviteToken(): string {
  const bytes = new Uint8Array(INVITE_TOKEN_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Could this redemption key be an ObjectId at all? Guards the legacy `_id` lookup, which casts
 * rather than returning null for a malformed value - a token reaching `findById` would throw a
 * CastError instead of the 404 the redemption paths are careful to return.
 */
export function isObjectIdShaped(key: string): boolean {
  return OBJECT_ID_SHAPE.test(key);
}
