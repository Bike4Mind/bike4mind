/**
 * node-saml CacheProvider backed by Mongo, wired into every SAML strategy in auth.ts.
 *
 * This is what makes `validateInResponseTo` usable: node-saml stores each outbound
 * AuthnRequest id here and removes it once the matching SAMLResponse is accepted, so a
 * captured assertion cannot be replayed within its NotOnOrAfter window. The library's
 * default provider keeps that state in process memory, which on Lambda would reject
 * legitimate logins whenever the response lands on a different instance than the one
 * that issued the request.
 *
 * Expiry is the collection's TTL index (see SamlRequestIdModel), not
 * `requestIdExpirationPeriodMs`: node-saml only prunes its own in-memory map.
 */
import { SamlRequestId } from '@bike4mind/database';
import type { CacheItem, CacheProvider } from '@node-saml/passport-saml';

export const samlRequestCache: CacheProvider = {
  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    // A duplicate id means node-saml generated a colliding request id, which it
    // treats as "already cached" - return null so it surfaces rather than throwing.
    const existing = await SamlRequestId.findOne({ requestId: key }).lean();
    if (existing) return null;

    const doc = await SamlRequestId.create({ requestId: key, value });
    return { value, createdAt: doc.createdAt.getTime() };
  },

  async getAsync(key: string): Promise<string | null> {
    const doc = await SamlRequestId.findOne({ requestId: key }).lean();
    return doc?.value ?? null;
  },

  async removeAsync(key: string | null): Promise<string | null> {
    if (!key) return null;
    // Single-use by construction: the delete is what closes the replay window, so a
    // second presentation of the same assertion finds nothing in getAsync.
    const doc = await SamlRequestId.findOneAndDelete({ requestId: key }).lean();
    return doc ? key : null;
  },
};
