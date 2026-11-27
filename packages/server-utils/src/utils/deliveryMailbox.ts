/**
 * The inbox an address delivers to, for grouping keys only (OTC limits in otcLimits.ts, the
 * aliasedEmail signup signal), never for account identity: a bomber or a farm can otherwise rotate
 * plus-tags, Gmail dots, or compatibility-form characters to look like a fresh address for the same
 * inbox. Folding more than strictly needed only makes a limit stricter.
 */
export function deliveryMailbox(email: string): string {
  const folded = email.normalize('NFKC').toLowerCase();
  const at = folded.lastIndexOf('@');
  if (at <= 0) return folded;
  let local = folded.slice(0, at);
  let domain = folded.slice(at + 1).replace(/\.+$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
