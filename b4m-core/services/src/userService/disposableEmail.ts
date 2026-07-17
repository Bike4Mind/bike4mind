import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// `disposable-email-domains` ships its list as index.json (its package `main`).
// A static `import ... from 'disposable-email-domains'` compiles to a bare ESM
// JSON import that Node 24 rejects without a `with { type: 'json' }` attribute -
// which rolldown (the CLI's bundler) does not emit, so the CLI crashed at startup
// with ERR_IMPORT_ATTRIBUTE_MISSING. We resolve the JSON's path and read it
// ourselves instead: require.resolve + readFileSync is not rewritten into a
// static import the way `require('disposable-email-domains')` would be, so it
// survives every bundler in the consumer graph.
//
// Built lazily (~4.5k entries) so consumers that never validate an email - e.g.
// the CLI, which bundles this module transitively but never calls it - never pay
// the ~2.4MB read/parse cost.
let disposableDomains: Set<string> | null = null;
const getDisposableDomains = (): Set<string> => {
  if (!disposableDomains) {
    const jsonPath = createRequire(import.meta.url).resolve('disposable-email-domains');
    disposableDomains = new Set<string>(JSON.parse(readFileSync(jsonPath, 'utf8')) as string[]);
  }
  return disposableDomains;
};

/**
 * True when the email's domain - or any parent domain - is a known disposable
 * provider. Parent-domain matching matters because services like Mailinator
 * accept mail on arbitrary subdomains (x@anything.mailinator.com), while the
 * list only carries the registrable domain.
 */
export const isDisposableEmail = (email: string): boolean => {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const DISPOSABLE_DOMAINS = getDisposableDomains();
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
