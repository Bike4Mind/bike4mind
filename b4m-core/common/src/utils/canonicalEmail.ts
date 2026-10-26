import { emailDomainOf } from './emailDomain';

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

// Providers that deliver `local+tag@domain` to `local@domain`. Only listed providers get the tag
// stripped: elsewhere `+` may be an ordinary character that names a different mailbox.
const PLUS_ADDRESSING_DOMAINS: ReadonlySet<string> = new Set([
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  'fastmail.com',
  'fastmail.fm',
]);

const stripPlusTag = (localPart: string): string => localPart.split('+')[0];

/**
 * The inbox an address delivers to, so aliases of one mailbox compare equal: lowercased, Gmail
 * dots and `+tag` dropped (googlemail.com folded into gmail.com), and `+tag` dropped for the
 * plus-addressing providers above. Other domains are only lowercased. Returns null when the
 * input has no usable local part or domain.
 *
 * Never use this as a login identity: it is a dedupe key (see UserRepository.claimFreeCreditGrant).
 */
export function canonicalizeEmail(email: string): string | null {
  const normalized = email.normalize('NFC').trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  const domain = emailDomainOf(normalized);
  if (atIndex <= 0 || !domain) return null;

  const localPart = normalized.slice(0, atIndex);
  if (GMAIL_DOMAINS.has(domain)) {
    const gmailLocal = stripPlusTag(localPart).replace(/\./g, '');
    return gmailLocal ? `${gmailLocal}@gmail.com` : null;
  }
  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    const baseLocal = stripPlusTag(localPart);
    return baseLocal ? `${baseLocal}@${domain}` : null;
  }
  return `${localPart}@${domain}`;
}
