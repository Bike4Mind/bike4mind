import disposableDomains from 'disposable-email-domains';

// Built once at module load; ~4.5k entries from the maintained
// `disposable-email-domains` list.
const DISPOSABLE_DOMAINS = new Set<string>(disposableDomains);

/**
 * True when the email's domain - or any parent domain - is a known disposable
 * provider. Parent-domain matching matters because services like Mailinator
 * accept mail on arbitrary subdomains (x@anything.mailinator.com), while the
 * list only carries the registrable domain.
 */
export const isDisposableEmail = (email: string): boolean => {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  let domain = email
    .slice(atIndex + 1)
    .toLowerCase()
    .trim()
    // Strip a trailing dot (fully-qualified DNS form, e.g. "mailinator.com.") so the
    // FQDN variant can't slip past a list that stores bare registrable domains.
    .replace(/\.$/, '');
  while (domain.includes('.')) {
    if (DISPOSABLE_DOMAINS.has(domain)) return true;
    domain = domain.slice(domain.indexOf('.') + 1);
  }
  return false;
};
