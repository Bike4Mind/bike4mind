import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';

const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
// A login response is a few KB; the cap keeps a deflated (HTTP-Redirect) body from expanding unbounded.
const MAX_INFLATED_BYTES = 1024 * 1024;

/** Refusal code for an assertion whose signed Issuer is not the one configured on the IdP that validated it. */
export const IDP_ISSUER_MISMATCH = 'idp_issuer_mismatch';

/**
 * The Issuer a SAMLResponse names, read before its signature is checked. It only picks which IdP
 * row validates the response: the SAML strategy (setupSamlStrategy in auth.ts) refuses an
 * assertion whose signed Issuer differs from that row's, so a forged value here only fails the login.
 */
export function samlResponseIssuer(samlResponse: unknown): string | undefined {
  if (typeof samlResponse !== 'string' || !samlResponse) return undefined;
  try {
    const decoded = Buffer.from(samlResponse, 'base64');
    const text = decoded.toString('utf8');
    const xml = text.trimStart().startsWith('<')
      ? text
      : inflateRawSync(decoded, { maxOutputLength: MAX_INFLATED_BYTES }).toString('utf8');
    const silent = () => undefined;
    const doc = new DOMParser({ errorHandler: { warning: silent, error: silent, fatalError: silent } }).parseFromString(
      xml,
      'text/xml'
    );
    // Document order: the Response's own Issuer comes before the assertion's.
    const issuer = doc.getElementsByTagNameNS(SAML_ASSERTION_NS, 'Issuer')[0]?.textContent?.trim();
    return issuer || undefined;
  } catch {
    return undefined;
  }
}
