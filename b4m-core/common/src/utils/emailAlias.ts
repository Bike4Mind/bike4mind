const GOOGLE_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Collapses the aliases of one inbox to a single key: lowercased, any "+tag" dropped from the
 * local part, and for Gmail the dots ignored and googlemail.com folded into gmail.com. Used to
 * tell whether an invited address is the sender's own inbox; it is not a general identity key,
 * since other providers may treat dots differently.
 */
export function inboxAliasKey(email: string): string {
  const [rawLocal = '', rawDomain = ''] = email.trim().toLowerCase().split('@');
  const domain = GOOGLE_MAIL_DOMAINS.has(rawDomain) ? 'gmail.com' : rawDomain;
  const local = rawLocal.split('+')[0];
  return `${domain === 'gmail.com' ? local.replace(/\./g, '') : local}@${domain}`;
}
