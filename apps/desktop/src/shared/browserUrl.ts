/**
 * What the agent's browser is allowed to open, and how typed text becomes an address.
 *
 * Shared because two things now decide it and they must decide it the same way: the agent's
 * `browser_navigate`, and the pane's own url bar. The renderer resolves what the user typed so
 * it can say what is wrong without a round trip; main resolves it again before loading
 * anything, because the renderer is not where this rule may be enforced.
 */

/**
 * Hosts the agent may browse and act on without asking: the user's own dev servers. Anything
 * else is a real site, where a click can buy, post or delete, so it is gated per origin.
 */
export function isLocalUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}

/**
 * A host, optionally with a port and a path, and no scheme: `example.com/cart`, `localhost:3080`,
 * `[::1]:3000`.
 *
 * Tested by shape rather than by asking URL whether a scheme is present, because `localhost:3080`
 * also parses as a URL whose scheme is `localhost`.
 */
const BARE_HOST = /^(\[[0-9a-f:]+\]|[^\s/:]+)(:\d+)?(\/|$)/i;

/** Anything of the form `scheme:`, which is a deliberate address even when it is refused. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Schemes the app serves itself, which this browser must never be talked into loading: both
 * hand out the user's own stored files straight out of the app, with no origin to gate them.
 *
 * Named rather than left to the scheme check below because `name:1234` is genuinely ambiguous -
 * it is how `localhost:3080` is written too - and the host-and-port reading has to lose for
 * these. Everything else with a scheme already falls through to that check.
 */
const APP_SCHEMES = ['b4m-media', 'b4m-artifact'];

/** Which of the app's own protocols this text is written in, if any. */
function appScheme(text: string): string | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  return scheme && APP_SCHEMES.includes(scheme) ? scheme : undefined;
}

/** Where free text goes when it is not an address. Google, which is what the user asked for. */
const SEARCH_URL = 'https://www.google.com/search?q=';

/**
 * A url the browser may load, from a bare host or a full one.
 *
 * Throws for every scheme that is not http or https. `file:` is the reason this is a hard
 * refusal rather than a warning: it would read the user's disk through a surface none of the
 * granted-roots checks can see, and the page's own JavaScript could then be asked to hand the
 * contents back. The app's `b4m-media:` and `b4m-artifact:` protocols are refused by the same
 * rule - they serve the user's own stored files straight out of the app.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  const app = appScheme(trimmed);
  if (app) throw new Error(`Only http and https pages can be opened, not ${app}:`);
  const bare = BARE_HOST.test(trimmed);
  const withScheme = bare ? `${isLocalUrl(`http://${trimmed}`) ? 'http' : 'https'}://${trimmed}` : trimmed;
  const url = new URL(withScheme);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https pages can be opened, not ${url.protocol}`);
  }
  return url.toString();
}

/**
 * Whether typed text is meant as an address at all.
 *
 * A scheme that is written out is always meant as one, including the refused ones: `file:///etc/
 * passwd` has to come back as a refusal the user can read, not quietly become a web search for
 * it. Everything else needs to look like a host - a dot, `localhost`, or a bracketed IPv6 - or
 * it is a search, because that is what `vitest watch mode` is.
 *
 * ANY dot makes it an address, with no list of real TLDs behind it, so `foo.bar` is opened
 * rather than searched for. The rule people can hold in their head is "a dot means go there",
 * and a TLD list is both large and wrong the week a new TLD ships - whereas guessing wrong
 * costs one visible `ERR_NAME_NOT_RESOLVED` in the bar, which the pane now says out loud, and
 * the text is still sitting there to be searched instead.
 */
function looksLikeAddress(text: string): boolean {
  if (/\s/.test(text)) return false;
  // `b4m-media:1234` reads as a host and port too, and must still reach the refusal.
  if (appScheme(text)) return true;
  if (HAS_SCHEME.test(text) && !BARE_HOST.test(text)) return true;
  const host = text.replace(/^\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
  return host.includes('.') || host === 'localhost' || /^\[.+\]$/.test(host);
}

/** A url to load, or why what was typed cannot become one. */
export type Address = { ok: true; url: string } | { ok: false; error: string };

/** What the url bar does with whatever the user typed into it. */
export function resolveAddress(typed: string): Address {
  const trimmed = typed.trim();
  if (!trimmed) return { ok: false, error: 'Type an address to open.' };
  if (!looksLikeAddress(trimmed)) return { ok: true, url: SEARCH_URL + encodeURIComponent(trimmed) };
  try {
    return { ok: true, url: normalizeUrl(trimmed) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : `${trimmed} is not an address this browser can open.`,
    };
  }
}
