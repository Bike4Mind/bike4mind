// `disposable-email-domains` ships its list as index.json (its package `main`).
// The `with { type: 'json' }` attribute is required for two independent reasons:
//   1. Node 24 (which runs the CLI) rejects a bare ESM JSON import without it
//      (ERR_IMPORT_ATTRIBUTE_MISSING) - the CLI's rolldown bundle keeps this
//      import external, so the attribute must reach the emitted output.
//   2. It stays a *static* import, so @vercel/nft (the tracer Next/OpenNext use
//      to build the server Lambda's file closure) includes index.json. A
//      createRequire/readFileSync form is invisible to nft and drops the file,
//      500-ing registration on deploy (isDisposableEmail runs by default).
import disposableDomains from 'disposable-email-domains' with { type: 'json' };

// ~4.5k entries from the maintained `disposable-email-domains` list.
const DISPOSABLE_DOMAINS = new Set<string>(disposableDomains as string[]);

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
