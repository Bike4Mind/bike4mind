import { extractEmails } from './validateSender';
import type { EmailAddress } from './types';

/**
 * The authserv-id SES stamps on the Authentication-Results header it prepends to every message
 * it receives. Verdicts are only computed when the receipt rule has `scanEnabled: true`
 * (infra/emailIngestion.ts) - keep that on, or every inbound mail fails closed here.
 */
export const SES_AUTHSERV_ID = 'amazonses.com';

const AUTHENTICATION_RESULTS_HEADER = 'authentication-results';

export type HeaderLine = { key: string; line: string };

type MethodResult = { result: string; properties: Record<string, string> };

export type AuthenticationResults = {
  authservId: string;
  spf: MethodResult[];
  dkim: MethodResult[];
  dmarc: MethodResult[];
};

export type SenderAuthenticationRejection =
  | 'missing-authentication-results'
  | 'untrusted-authserv-id'
  | 'missing-sender'
  | 'multiple-senders'
  | 'dmarc-domain-mismatch'
  | 'dmarc-failed'
  | 'no-aligned-dkim';

export type SenderAuthenticationVerdict =
  | { authenticated: true; senderDomain: string; via: 'dmarc' | 'aligned-dkim' }
  | { authenticated: false; reason: SenderAuthenticationRejection };

/**
 * Returns the value of the topmost Authentication-Results header, or undefined if there is none.
 *
 * Only the topmost one can be trusted: SES prepends its own above the sender's headers, so any
 * look-alike the sender injected sits below it and is ignored.
 */
export function findTopmostAuthenticationResults(headerLines: ReadonlyArray<HeaderLine>): string | undefined {
  const header = headerLines.find(({ key }) => key.toLowerCase() === AUTHENTICATION_RESULTS_HEADER);
  if (!header) return undefined;

  const separatorIndex = header.line.indexOf(':');
  return unfold(header.line.slice(separatorIndex + 1));
}

/**
 * Parses an RFC 8601 Authentication-Results value. Unknown methods and the SES-specific
 * `key=value` segments that follow `spf=` (client-ip, envelope-from, helo) are ignored.
 */
export function parseAuthenticationResults(value: string): AuthenticationResults {
  const [authservSegment = '', ...resultSegments] = stripComments(unfold(value)).split(';');
  const results: AuthenticationResults = {
    authservId: authservSegment.trim().split(/\s+/)[0]?.toLowerCase() ?? '',
    spf: [],
    dkim: [],
    dmarc: [],
  };

  for (const segment of resultSegments) {
    const [methodToken, ...propertyTokens] = segment.trim().split(/\s+/);
    const methodMatch = /^(spf|dkim|dmarc)=([a-z]+)$/i.exec(methodToken ?? '');
    if (!methodMatch) continue;

    const method = methodMatch[1].toLowerCase() as 'spf' | 'dkim' | 'dmarc';
    results[method].push({ result: methodMatch[2].toLowerCase(), properties: parseProperties(propertyTokens) });
  }

  return results;
}

/**
 * Decides whether the From address is authenticated, from the topmost Authentication-Results.
 *
 * Accepts DMARC pass for the From domain. When the From domain publishes no DMARC record
 * (dmarc=none), accepts a DKIM pass whose signing domain is the From domain or a parent of it.
 * Everything else fails closed - including an SPF pass, which authenticates the envelope sender
 * rather than the From address a user sees.
 */
export function authenticateSender(
  from: EmailAddress | EmailAddress[] | undefined,
  authenticationResults: string | undefined
): SenderAuthenticationVerdict {
  if (!authenticationResults) return reject('missing-authentication-results');

  const results = parseAuthenticationResults(authenticationResults);
  if (results.authservId !== SES_AUTHSERV_ID) return reject('untrusted-authserv-id');

  // DMARC is undefined for a message with several From addresses (RFC 7489 6.6.1), and
  // validateSenderAuthorization only ever looks at the first one.
  const senders = extractEmails(from);
  if (senders.length === 0) return reject('missing-sender');
  if (senders.length > 1) return reject('multiple-senders');

  const senderDomain = domainOf(senders[0]);
  if (!senderDomain) return reject('missing-sender');

  const dmarc = results.dmarc[0];
  if (dmarc?.result === 'pass') {
    // A pass only vouches for the domain it was evaluated against.
    if (dmarc.properties['header.from']?.toLowerCase() !== senderDomain) return reject('dmarc-domain-mismatch');
    return { authenticated: true, senderDomain, via: 'dmarc' };
  }
  if (dmarc && dmarc.result !== 'none') return reject('dmarc-failed');

  const hasAlignedDkim = results.dkim.some(
    dkim => dkim.result === 'pass' && isSameOrParentDomain(dkimSigningDomain(dkim), senderDomain)
  );
  return hasAlignedDkim ? { authenticated: true, senderDomain, via: 'aligned-dkim' } : reject('no-aligned-dkim');
}

function reject(reason: SenderAuthenticationRejection): SenderAuthenticationVerdict {
  return { authenticated: false, reason };
}

function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, ' ').trim();
}

// Comments may contain ';' (e.g. SES's "spfCheck: ..." explanations), so drop them before splitting.
function stripComments(value: string): string {
  return value.replace(/\([^()]*\)/g, ' ');
}

function parseProperties(tokens: string[]): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const token of tokens) {
    const separatorIndex = token.indexOf('=');
    if (separatorIndex <= 0) continue;
    properties[token.slice(0, separatorIndex).toLowerCase()] = token.slice(separatorIndex + 1);
  }
  return properties;
}

function dkimSigningDomain({ properties }: MethodResult): string | undefined {
  const domain = properties['header.d'] ?? domainOf(properties['header.i'] ?? '');
  return domain?.toLowerCase();
}

function domainOf(address: string): string | undefined {
  const atIndex = address.lastIndexOf('@');
  const domain = atIndex >= 0 ? address.slice(atIndex + 1) : '';
  return domain ? domain.toLowerCase() : undefined;
}

// A signer can only publish a DKIM key under a domain it controls, so a parent of the From
// domain is as trustworthy as the From domain itself.
function isSameOrParentDomain(candidate: string | undefined, domain: string): boolean {
  if (!candidate) return false;
  return domain === candidate || domain.endsWith(`.${candidate}`);
}
