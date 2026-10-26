import { emailDomainOf } from './emailDomain';

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

// Domains where one username is one mailbox, so `a@me.com` and `a@icloud.com` reach the same inbox.
const SAME_MAILBOX_DOMAINS: ReadonlyMap<string, string> = new Map([
  ['me.com', 'icloud.com'],
  ['mac.com', 'icloud.com'],
  ['protonmail.com', 'proton.me'],
  ['protonmail.ch', 'proton.me'],
  ['pm.me', 'proton.me'],
]);

// Providers that deliver `local+tag@domain` to `local@domain`. Only listed providers get the tag
// stripped: elsewhere `+` may be an ordinary character that names a different mailbox.
const PLUS_ADDRESSING_DOMAINS: ReadonlySet<string> = new Set([
  'outlook.com',
  'outlook.co.uk',
  'outlook.de',
  'outlook.fr',
  'outlook.es',
  'outlook.it',
  'outlook.jp',
  'hotmail.com',
  'hotmail.co.uk',
  'hotmail.de',
  'hotmail.fr',
  'hotmail.es',
  'hotmail.it',
  'live.com',
  'live.co.uk',
  'live.de',
  'live.fr',
  'msn.com',
  'icloud.com',
  'proton.me',
  'fastmail.com',
  'fastmail.fm',
]);

const stripPlusTag = (localPart: string): string => localPart.split('+')[0];

/**
 * The inbox an address delivers to, so aliases of one mailbox compare equal: lowercased, Gmail
 * dots and `+tag` dropped (googlemail.com folded into gmail.com), same-mailbox domains folded
 * (me.com into icloud.com, pm.me into proton.me), and `+tag` dropped for the plus-addressing
 * providers above. Other domains are only lowercased. Returns null when the input has no usable
 * local part or domain.
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
  const mailboxDomain = SAME_MAILBOX_DOMAINS.get(domain) ?? domain;
  if (PLUS_ADDRESSING_DOMAINS.has(mailboxDomain)) {
    const baseLocal = stripPlusTag(localPart);
    return baseLocal ? `${baseLocal}@${mailboxDomain}` : null;
  }
  return `${localPart}@${mailboxDomain}`;
}
