import { domainToASCII } from 'url';
import { extractEmails } from './validateSender';
import type { EmailAddress, SenderAuthenticationHeaders } from './types';

/**
 * The authserv-id SES stamps on the Authentication-Results header it prepends to every message
 * it receives (with `scanEnabled: true` on the receipt rule in infra/emailIngestion.ts). The
 * gate trusts SES to always stamp it: were SES to omit it, a look-alike the sender wrote would
 * become the topmost header.
 */
export const SES_AUTHSERV_ID = 'amazonses.com';

const AUTHENTICATION_RESULTS_HEADER = 'authentication-results';
const FROM_HEADER = 'from';

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
  | 'missing-dmarc-result'
  | 'multiple-dmarc-results'
  | 'dmarc-domain-mismatch'
  | 'dmarc-failed'
  | 'no-aligned-dkim';

export type SenderAuthenticationVerdict =
  | { authenticated: true; senderDomain: string; via: 'dmarc' | 'aligned-dkim' }
  | { authenticated: false; reason: SenderAuthenticationRejection };

/**
 * Reads what authenticateSender needs from a message's ordered header lines (mailparser's
 * `headerLines`): the topmost Authentication-Results value, with its folding kept, and how many
 * From headers there are - parsers keep only one, so a second would otherwise go unseen.
 *
 * Only the topmost Authentication-Results can be trusted: SES prepends its own above the
 * sender's headers, so any look-alike the sender injected sits below it and is ignored.
 */
export function readSenderAuthenticationHeaders(headerLines: ReadonlyArray<HeaderLine>): SenderAuthenticationHeaders {
  const header = headerLines.find(({ key }) => key.toLowerCase() === AUTHENTICATION_RESULTS_HEADER);
  return {
    authenticationResults: header?.line.slice(header.line.indexOf(':') + 1).trim(),
    fromHeaderCount: headerLines.filter(({ key }) => key.toLowerCase() === FROM_HEADER).length,
  };
}

/**
 * Parses an SES Authentication-Results value, which puts the authserv-id on the first line and
 * each method result on its own folded line.
 *
 * Only the leading result on each line is read. SES echoes the sender's MAIL FROM and HELO after
 * `spf=` on the same line, so anything past that line's first top-level ';' is sender-controlled;
 * a sender cannot fold a new line into it because SMTP commands end at CRLF.
 */
export function parseAuthenticationResults(value: string): AuthenticationResults {
  const [firstLine = '', ...resultLines] = value.split(/\r?\n(?=[ \t])/);
  const results: AuthenticationResults = {
    authservId: tokens(leadingSegment(firstLine))[0]?.toLowerCase() ?? '',
    spf: [],
    dkim: [],
    dmarc: [],
  };

  for (const line of resultLines) {
    const [methodToken = '', ...propertyTokens] = tokens(leadingSegment(line));
    const methodMatch = /^(spf|dkim|dmarc)=([a-z]+)$/i.exec(methodToken);
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
 * (dmarc=none), accepts a DKIM pass aligned with the From domain. Everything else fails closed -
 * including an SPF pass, which authenticates the envelope sender rather than the From address a
 * user sees.
 */
export function authenticateSender(
  from: EmailAddress | EmailAddress[] | undefined,
  headers: SenderAuthenticationHeaders | undefined
): SenderAuthenticationVerdict {
  if (!headers?.authenticationResults) return reject('missing-authentication-results');

  const results = parseAuthenticationResults(headers.authenticationResults);
  if (results.authservId !== SES_AUTHSERV_ID) return reject('untrusted-authserv-id');

  // DMARC is undefined for a message with several From addresses or headers (RFC 7489 6.6.1),
  // and validateSenderAuthorization only ever looks at the first address.
  const senders = extractEmails(from);
  if (senders.length === 0 || headers.fromHeaderCount === 0) return reject('missing-sender');
  if (senders.length > 1 || headers.fromHeaderCount > 1) return reject('multiple-senders');

  const senderDomain = normalizeDomain(domainOf(senders[0]));
  if (!senderDomain) return reject('missing-sender');

  if (results.dmarc.length === 0) return reject('missing-dmarc-result');
  if (results.dmarc.length > 1) return reject('multiple-dmarc-results');

  const [dmarc] = results.dmarc;
  if (dmarc.result === 'pass') {
    // A pass only vouches for the domain it was evaluated against.
    if (normalizeDomain(dmarc.properties['header.from']) !== senderDomain) return reject('dmarc-domain-mismatch');
    return { authenticated: true, senderDomain, via: 'dmarc' };
  }
  if (dmarc.result !== 'none') return reject('dmarc-failed');

  const hasAlignedDkim = results.dkim.some(
    dkim => dkim.result === 'pass' && isAligned(dkimSigningDomain(dkim), senderDomain)
  );
  return hasAlignedDkim ? { authenticated: true, senderDomain, via: 'aligned-dkim' } : reject('no-aligned-dkim');
}

function reject(reason: SenderAuthenticationRejection): SenderAuthenticationVerdict {
  return { authenticated: false, reason };
}

/** The text before the first ';' that is outside a quoted string or a (nested) comment, comments dropped. */
function leadingSegment(line: string): string {
  let segment = '';
  let commentDepth = 0;
  let inQuotes = false;

  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (inQuotes) {
      segment += char;
      if (char === '\\') segment += line[++index] ?? '';
      else if (char === '"') inQuotes = false;
    } else if (commentDepth > 0) {
      if (char === '\\') index++;
      else if (char === '(') commentDepth++;
      else if (char === ')') commentDepth--;
    } else if (char === ';') {
      break;
    } else if (char === '(') {
      commentDepth++;
      segment += ' ';
    } else {
      if (char === '"') inQuotes = true;
      segment += char;
    }
  }

  return segment;
}

function tokens(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

function parseProperties(propertyTokens: string[]): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const token of propertyTokens) {
    const separatorIndex = token.indexOf('=');
    if (separatorIndex <= 0) continue;
    properties[token.slice(0, separatorIndex).toLowerCase()] = token.slice(separatorIndex + 1);
  }
  return properties;
}

// SES reports the AUID (header.i), which is the signing domain or a subdomain of it.
function dkimSigningDomain({ properties }: MethodResult): string | undefined {
  return normalizeDomain(properties['header.d'] ?? domainOf(properties['header.i'] ?? ''));
}

function domainOf(address: string): string | undefined {
  const atIndex = address.lastIndexOf('@');
  return atIndex >= 0 ? address.slice(atIndex + 1) : undefined;
}

// Compares in punycode, since SES reports an IDN From domain in its ASCII form.
function normalizeDomain(domain: string | undefined): string | undefined {
  const ascii = domain ? domainToASCII(domain.replace(/\.$/, '')) : '';
  return ascii || undefined;
}

// Relaxed alignment without a public-suffix list: one domain must contain the other. That is
// safe because a DKIM pass needs a key published under the signing domain, so a signer can
// only pass for a domain it controls.
function isAligned(signingDomain: string | undefined, senderDomain: string): boolean {
  if (!signingDomain) return false;
  return (
    signingDomain === senderDomain ||
    senderDomain.endsWith(`.${signingDomain}`) ||
    signingDomain.endsWith(`.${senderDomain}`)
  );
}
