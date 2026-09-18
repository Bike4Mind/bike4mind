import { Logger } from '@bike4mind/observability';
import axios from 'axios';
import type { Cheerio, CheerioAPI } from 'cheerio';
import mime from 'mime-types';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent, validateUrlForFetch } from './ssrfProtection';

// Centralized URL regex - handles ports, query params, fragments
export const URL_REGEX =
  /https?:\/\/(?:[-\w.])+(?:\:[0-9]+)?(?:\/(?:[\w\/_.])*(?:\?(?:[\w&=%.])*)?(?:\#(?:[\w.])*)?)?/gi;

export function detectURLs(string: string): string[] {
  const urlsFound = string.match(URL_REGEX) || [];
  return urlsFound;
}

// Check if a string contains any URLs
export function hasURLs(string: string): boolean {
  return URL_REGEX.test(string);
}

// Check if a string contains URLs and return them
export function urlExists(stringWithPossibleUrl: string): string[] {
  const cleanString = stringWithPossibleUrl.replace(/\n/g, ' ').replace(/,/g, ' ');
  return detectURLs(cleanString);
}

interface ParsedContent {
  title: string;
  textContent: Buffer | string;
  mimeType: string;
  ext: string | null;
}

// Default timeout for URL fetching (10 seconds)
const URL_FETCH_TIMEOUT_MS = 10_000;

/**
 * Redirect hops followed before giving up. Deliberately far below axios's own default of 21: every
 * hop costs a DNS resolution plus a request, and no legitimate document needs more than a couple.
 */
const MAX_REDIRECTS = 5;

/**
 * Hard ceiling on a fetched body. A SAFETY NET against an unbounded response, not a policy limit -
 * `createFabFile` still enforces the `MaxFileSize` admin setting afterwards. Set generously (the
 * same 50MB as the Slack attachment ceiling) so it can never refuse something the app would accept;
 * without it axios defaults to `maxContentLength: -1`, i.e. buffer whatever the server sends, and
 * `@datalake add <link>` takes URLs from anyone who can type in a Slack channel.
 */
const URL_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/**
 * PDF test against the URL's PATH only. The previous form (`url.split('.').pop().startsWith('pdf')`)
 * also matched a query string, so `?doc=report.pdf` on an HTML page was fetched as a PDF.
 */
function isPdfUrl(url: string): boolean {
  // Deliberately NO try/catch. An unparseable URL cannot reach here - `fetchAndParseURL` only calls
  // this after `validateUrlForFetch(currentUrl)` accepted the address, and anything that parses for
  // the guard parses for `new URL` here. If that ever stops being true, letting the throw propagate
  // is the behaviour we want: `fetchAndParseURL`'s outer catch records `failedUrl` and rethrows, so it
  // surfaces as an ordinary fetch failure instead of being silently classified as not-a-PDF.
  //
  // The tempting fallback - split on '.' and test the last segment - is exactly the behaviour this
  // function replaced, so keeping it as an unreachable safety net would quietly reintroduce the
  // `?doc=report.pdf` mis-parse in the one branch nobody ever reads.
  return new URL(url).pathname.toLowerCase().endsWith('.pdf');
}

/**
 * True when the body opens with the PDF signature.
 *
 * Closes the door `isPdfUrl` cannot reach: a download endpoint with no `.pdf` in its path, served as
 * `application/octet-stream`, produced neither a Content-Type signal nor an extension signal and was
 * decoded as text - the same `toString('utf8')` corruption the Content-Type fallback exists to
 * prevent, arriving through the one remaining door. `/download?id=123` and `Content-Disposition`
 * attachment links are exactly this shape.
 *
 * Checked at offset 0 only. The PDF spec tolerates leading bytes before the header and readers scan
 * ahead for it, but scanning here would mean sniffing arbitrary attacker-supplied content to
 * RE-CLASSIFY it, and a false positive sends a real text document into the PDF parser. The strict
 * check costs nothing on well-formed files, which is every file this has been observed to affect.
 *
 * Deliberately consulted ONLY on the generic-binary branch, never to override a server that stated a
 * type. A server declaring `text/html` while sending PDF bytes is a different (and unobserved) bug,
 * and overriding an explicit Content-Type is a wider behaviour change than this fix needs.
 */
function hasPdfMagicBytes(body: Buffer): boolean {
  return body.subarray(0, 5).toString('latin1') === '%PDF-';
}

/**
 * Strip embedded credentials before a URL is written to a log.
 *
 * `https://user:pass@host/doc` is a legitimate paste, and this function is reached from the Slack
 * `@datalake add` path and the LLM URL-fetch path - both of which take URLs from whoever can type in
 * a channel or a chat. The FETCH still uses the original URL; only what is recorded is redacted, and a
 * log line outlives the message that produced it.
 *
 * MUST STAY IN SYNC with `sanitizeUrlForRecord` in `apps/client/server/slack/dataLakeLinkIngest.ts`,
 * which does the same job for the PERSISTED provenance record. Deliberately duplicated rather than
 * shared: exporting this would change `fab-pipeline`'s public surface, which its own `index.test.ts`
 * pins as an explicit list of names.
 */
function redactUrlCredentials(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password) return raw;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Unparseable, so the credentials cannot be located to strip them. Log nothing rather than guess.
    return '[unparseable url]';
  }
}

/** Last path segment, used only as a display-name fallback when a page has no `<title>`. */
function lastPathSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url.split('/')?.pop() ?? url;
  }
}

/**
 * Fetch one URL without following redirects, so the caller can SSRF-validate each hop itself.
 *
 * SECURITY: this is why `maxRedirects: 0` is set rather than left at axios's default. Validating
 * only the URL the user supplied is not enough - axios would follow the redirect chain internally,
 * so any public host could answer `302 Location: http://169.254.169.254/latest/meta-data/` and the
 * guard would never see the address actually fetched.
 *
 * SECURITY: the agents are the OTHER half, and the two guard different attacks. Per-hop
 * `validateUrlForFetch` judges each address the chain names; the agents' `ssrfSafeLookup` judges the
 * IP each socket actually dials. Without the agents a hostname that passes validation and then
 * re-resolves to a private address on connect - DNS rebinding - reaches the internal destination with
 * every URL-level check having passed. Both are needed: the pre-flight sees the scheme and the typed
 * literal, the lookup sees the truth at connect time.
 *
 * `timeoutMs` is the budget REMAINING for the whole operation, not a fresh per-hop allowance - see
 * the deadline in `fetchAndParseURL`.
 */
async function fetchWithoutRedirects(url: string, timeoutMs: number) {
  return axios.get(url, {
    // BOTH agents, because the scheme is not fixed across a chain: an https URL can 302 to http, and
    // axios picks the agent per request from the scheme it is currently on.
    httpAgent: ssrfSafeHttpAgent,
    httpsAgent: ssrfSafeHttpsAgent,
    // MUST accompany the agents, or they silently stop protecting anything. axios reads
    // `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` from the environment by default: for an https target its
    // `setProxy` installs a CONNECT-tunnelling agent and assigns `options.agent` BEFORE the fallback
    // that would have used ours, and for an http target the forward-proxy branch rewrites host and
    // port so our lookup would validate the PROXY's address rather than the target's. Either way the
    // connect-time pin is gone while every URL-level check still passes - i.e. the exact bypass the
    // pin exists to prevent, reintroduced by an env var. No proxy is configured in the server runtime
    // today; this makes the guarantee unconditional rather than environment-dependent.
    proxy: false,
    // ALWAYS bytes. The response type cannot be chosen from the caller's URL, because a redirect can
    // land on a different content type entirely - a `.pdf` URL that 302s to an HTML gateway page, or
    // an extensionless URL that 302s to a PDF. Fetching bytes and deciding how to parse AFTERWARDS,
    // from the final response's own Content-Type, removes the guess and the mis-parse it caused.
    responseType: 'arraybuffer',
    timeout: timeoutMs, // Prevent Lambda timeout exhaustion
    maxRedirects: 0,
    maxContentLength: URL_MAX_RESPONSE_BYTES,
    maxBodyLength: URL_MAX_RESPONSE_BYTES,
    // 3xx must reach us as a value rather than a throw; anything else keeps axios's default.
    validateStatus: status => (status >= 200 && status < 300) || (status >= 300 && status < 400),
  });
}

// Elements after which we force a line break, since cheerio's `.text()` on the whole body
// otherwise concatenates every text node with no separator at all - a heading, a list item and
// the next paragraph would run together as one word-jammed line. Framed as a DENYLIST of inline
// elements rather than an allowlist of block ones: an allowlist is an open set that keeps
// drifting as new pages exercise tags it didn't cover (this one already grew twice, from a bare
// div-only list to adding article/section/header/footer/main/dt/dd/figcaption/caption, and still
// missed summary/nav/aside/address/option/button). The HTML5 inline-element set is closed by
// spec, so excluding it closes the gap for good - everything that isn't inline gets a break.
// `td`/`th` are carved out here since they get their own space-only separator below (same row,
// not a new line).
const INLINE_SELECTOR =
  'a, span, em, strong, b, i, u, code, kbd, samp, var, sub, sup, small, abbr, cite, q, time, mark, s, del, ins, bdi, bdo, wbr, ruby, rt, rp';
const BLOCK_LEVEL_SELECTOR = `*:not(${INLINE_SELECTOR.split(', ').join('):not(')}):not(td):not(th)`;

/**
 * cheerio's `AnyNode`, named without importing `domhandler` directly - that is a transitive dep of
 * cheerio rather than one of ours, and cheerio re-exports the type only under aliases like this.
 */
type DomNode = Parameters<CheerioAPI['contains']>[0];

/**
 * Elements that carry UI rather than prose, removed before extraction.
 *
 * Two principles only, deliberately narrow - `nav`/`header`/`footer`/`aside` are NOT here, because
 * pages do put real content in the last two and a full boilerplate pass is a different job:
 *  - `aria-hidden`/`hidden`: the page itself says this is not content to be read. That is what
 *    catches the duplicated tooltip labels modern doc sites render next to every icon button
 *    ("Collapse sidebar", "Search or ask Copilot"), which are plain `<span>`s with no other signal.
 *  - interactive controls, native or via the equivalent ARIA role: a control's label is an
 *    instruction to the reader, not part of the document.
 */
const NON_CONTENT_SELECTOR = [
  '[aria-hidden="true"]',
  '[hidden]',
  'button',
  'input',
  'select',
  'textarea',
  'option',
  'optgroup',
  'datalist',
  'label',
  'dialog',
  'template',
  // No text an embedding can use: icon markup, and `<title>`/`<desc>` that exist for screen readers.
  'svg',
  '[role="button"]',
  '[role="search"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="tablist"]',
  '[role="toolbar"]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="tooltip"]',
  '[role="radiogroup"]',
].join(', ');

/**
 * What counts as a control when judging a control strip. Broader than `NON_CONTENT_SELECTOR`,
 * because a link is content in prose but a control in a nav bar - `a[href]` is the only reason the
 * strip rule can see an unmarked `<div>` of nav links as chrome at all.
 */
const CONTROL_SELECTOR =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"]';

/**
 * Containers a control strip can be. Headings and `<p>` are excluded: `<h2><a>Title</a></h2>` is
 * content. `<table>`/`<tbody>`/`<tr>` and `<li>` are excluded too: a row of short linked cells is
 * how an ordinary reference table looks, never a nav bar, and a list is judged at the `<ul>`/`<ol>`
 * level as a whole rather than letting one busy `<li>` speak for it.
 */
const STRIP_CONTAINER_SELECTOR = 'div, span, ul, ol, nav, header, footer, aside, section, form';

/**
 * Ancestor tags that mark "this element sits inside running prose", not "this element is a
 * standalone block". A `span` wrapping two inline links in the middle of a sentence looks
 * structurally identical to a toolbar to `isControlStrip` - same tag, same two-control shape - but
 * removing it deletes words out of a sentence rather than a block of chrome, which reads as fluent,
 * complete prose with a fact silently missing. A strip candidate found inside one of these is
 * declined outright, before `isControlStrip` ever runs, since content ancestry is a stronger signal
 * than anything the candidate's own subtree can show.
 */
const PROSE_ANCESTOR_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, blockquote, figcaption, caption';

/**
 * Minimum controls for a `<ul>`/`<ol>` candidate specifically - higher than the general
 * `MIN_STRIP_CONTROLS` below. A bare two-item list is exactly as likely to be two related content
 * links (a "see also" pair) as it is a nav, and unlike a `<nav>`/`<header>`/`<footer>` landmark - which
 * already declares itself as chrome by tag - a plain `<ul>` carries no such signal. Landmark tags and
 * `<div>`/`<span>` keep the lower threshold: a two-item breadcrumb or tab strip ("Home / Docs") is
 * common and short by nature.
 */
const MIN_LIST_STRIP_CONTROLS = 3;

/**
 * Minimum controls for any other strip candidate (`div`, `span`, `nav`, `header`, `footer`, `aside`,
 * `section`, `form`) - what keeps `<div><a>An article title</a></div>` on a card, a single link
 * card being indistinguishable in shape from a one-item nav. `<li>` is not itself a
 * `STRIP_CONTAINER_SELECTOR` tag, so a list item is never a candidate this constant adjudicates at
 * all; a list is judged as a whole at the `<ul>`/`<ol>` level via `MIN_LIST_STRIP_CONTROLS` instead.
 */
const MIN_STRIP_CONTROLS = 2;

/**
 * Longest a single control's label may be before the group stops looking like a control strip.
 * Nav items, tabs and toolbar buttons are a word or three; anything longer is prose in a link.
 */
const MAX_CONTROL_LABEL_CHARS = 40;

/**
 * How much non-control text a strip candidate may still carry before it stops looking like chrome.
 * Requiring exactly zero (the previous rule) let a single stray word - a wordmark, a version
 * string, a bare "Menu" - defeat the whole strip and leak the nav into stored content. Budgeted
 * small and absolute, at wordmark scale rather than sentence scale.
 *
 * Only granted to a candidate matching `LANDMARK_CHROME_SELECTOR` - see there for why a `div`/
 * `span`/`section` candidate does not get this budget at all.
 */
const MAX_NON_CONTROL_TEXT_CHARS = 15;

/**
 * Tags and roles that self-declare as chrome regardless of what they contain - the only
 * candidates `MAX_NON_CONTROL_TEXT_CHARS`'s wordmark-scale budget applies to. A `div`/`span`/
 * `section`/`ul`/`ol`/`form` carries no such signal and is exactly where a CMS renders a short,
 * genuine callout ("Related: <a>X</a> and <a>Y</a>."): granting it the same budget let a
 * self-contained sentence-plus-links block clear `isControlStrip` on its own short lead-in text
 * and get deleted whole, with nothing downstream able to tell it happened. Those tags instead
 * fall back to requiring non-control text be separator punctuation only (see `isControlStrip`),
 * same as every candidate did before this budget existed.
 */
const LANDMARK_CHROME_SELECTOR =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';

/**
 * How much of a container's nesting depth (from the document root, so a page with no `<main>`
 * and one that has it are budgeted the same way) the strip check will still climb to evaluate.
 * `isControlStrip` scans a candidate's ENTIRE subtree, so checking every container in a deeply
 * nested document is quadratic in nesting depth - and nesting is entirely up to whatever HTML the
 * fetched URL happens to return. Nesting past this depth stops being checked as a strip candidate
 * rather than being paid for on every level.
 *
 * Sized well clear of real layout nesting - the deepest control group measured live against
 * react.dev, tailwindcss.com and docs.github.com sits at 16 - but a control strip nested deeper
 * than this is a real, deliberate gap: it is never evaluated at all, at any depth from here to its
 * leaves, since every one of its descendants is at least as deep. Closing that gap properly needs
 * either a much higher cap (which reopens the cost problem this constant exists to bound) or
 * skipping only the expensive subtree scan while still descending past the cap - out of scope
 * here; see the boundary test pinning today's behavior instead of leaving it undocumented.
 */
const MAX_STRIP_CONTAINER_DEPTH = 32;

/**
 * How much of the scope's own surviving text has to remain, after chrome pruning, before that
 * pruning is trusted. Below this, pruning is treated as having taken real content down with it -
 * see `pruneChromeFromScope`. Sized between a bare boilerplate remnant (a copyright line, a
 * "Further reading." label - fifteen to twenty characters) and a real one-sentence page ("The
 * chapter itself, in prose." - twenty-nine): short enough that a genuinely tiny real page still
 * survives, long enough that what a footer or a stray label leaves behind on its own doesn't.
 *
 * Known limitation: an absolute count cannot always tell a genuine short sentence from a
 * same-length piece of boilerplate (a copyright line can be as long as an intro sentence) - see
 * `pruneChromeFromScope` for why the alternative (weighing the bar against how much was removed)
 * was tried and reverted.
 */
const MIN_SURVIVING_CONTENT_CHARS = 20;

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Nesting depth of `element` below `within`, walking parent pointers directly rather than through
 * cheerio's `.parents()` (which itself re-walks the chain with wrapper allocation at every step) -
 * this runs once per strip candidate, so it has to stay cheap even though `isControlStrip` itself
 * is not.
 */
function depthWithin(element: DomNode, within: DomNode): number {
  let depth = 0;
  // `.parent` is a domhandler property untyped on the public `AnyNode` union we widen to.
  let current = (element as { parent?: DomNode | null }).parent;
  while (current && current !== within) {
    depth++;
    current = (current as { parent?: DomNode | null }).parent;
  }
  return depth;
}

/**
 * True when `element` has an ancestor (below `boundary`, exclusive) that marks it as sitting inside
 * running prose rather than being a standalone block - see `PROSE_ANCESTOR_SELECTOR`. Walks parent
 * pointers directly for the same reason `depthWithin` does: this runs once per strip candidate.
 */
function hasProseAncestor($: CheerioAPI, element: DomNode, boundary: DomNode): boolean {
  let current = (element as { parent?: DomNode | null }).parent;
  while (current && current !== boundary) {
    if ($(current).is(PROSE_ANCESTOR_SELECTOR)) return true;
    current = (current as { parent?: DomNode | null }).parent;
  }
  return false;
}

/**
 * True when `element` sits directly between two pieces of running text - a non-whitespace text
 * node as its immediately preceding or following sibling. That is the tag-agnostic version of
 * "this element sits inside running prose": `PROSE_ANCESTOR_SELECTOR` only protects a candidate
 * whose ANCESTOR is one of a fixed list of tags (`p`, headings, `li`, ...), so the same inline
 * `<span>` wrapping two links reads as protected prose inside a `<p>` but as a standalone chrome
 * candidate inside a `<div>`, `<section>` or `<td>` - none of which are prose landmarks, but all of
 * which routinely hold hand-written or CMS-rendered sentences. A text-node sibling is the
 * strongest tag-independent signal that removing `element` would leave a dangling sentence rather
 * than delete a block of chrome, regardless of what its parent is called.
 */
function hasAdjacentProseText(element: DomNode): boolean {
  const node = element as { prev?: DomNode | null; next?: DomNode | null };
  const isNonWhitespaceText = (sibling: DomNode | null | undefined): boolean => {
    const candidate = sibling as { type?: string; data?: string } | null | undefined;
    return !!candidate && candidate.type === 'text' && squash(candidate.data ?? '').length > 0;
  };
  return isNonWhitespaceText(node.prev) || isNonWhitespaceText(node.next);
}

/**
 * True when an element is a group of adjacent controls with no prose of its own - a nav bar, a
 * breadcrumb row, a tab strip, a footer link column, a sandbox toolbar.
 *
 * Needs `MIN_LIST_STRIP_CONTROLS` for a `<ul>`/`<ol>` candidate and `MIN_STRIP_CONTROLS` otherwise -
 * see those constants for why the two differ. It also has to run BEFORE the controls themselves
 * are removed, or the evidence is gone: react.dev's `Fork` link only reads as chrome because the
 * `Reload` and `Clear` buttons share its toolbar.
 *
 * "No prose of its own" tolerates the punctuation sites use to separate items, so a `A | B | C`
 * nav still qualifies, and now also a small budget of non-separator text - see
 * `MAX_NON_CONTROL_TEXT_CHARS`.
 */
function isControlStrip($: CheerioAPI, element: DomNode): boolean {
  const $element = $(element);
  if (!squash($element.text())) return false;

  const controls = $element.find(CONTROL_SELECTOR);
  const isList = $element.is('ul, ol');
  if (controls.length < (isList ? MIN_LIST_STRIP_CONTROLS : MIN_STRIP_CONTROLS)) return false;

  for (const control of controls.toArray()) {
    const label = squash($(control).text());
    if (label.length > MAX_CONTROL_LABEL_CHARS || /[.!?]\s/.test(label)) return false;
  }

  const outsideControls = $element.clone().find(CONTROL_SELECTOR).remove().end().text();
  const strippedOutsideControls = outsideControls.replace(/[\s|\u00b7\u2022/,:;-]+/g, '');
  const budget = $element.is(LANDMARK_CHROME_SELECTOR) ? MAX_NON_CONTROL_TEXT_CHARS : 0;
  return strippedOutsideControls.length <= budget;
}

/**
 * Removes control strips and non-content elements from `scope`, together, with ONE rollback
 * covering both.
 *
 * Both prunings are done via a placeholder swap rather than an outright `remove()`, so either can
 * be undone. They are decided together - not the strip rule with its own guard and the non-content
 * removal with none - because a subtree that is real content by itself can sit entirely inside a
 * `label`/`dialog`/`aria-hidden` wrapper (a client framework's whole-page aria-hidden mount, an
 * article rendered inside a `<dialog>`), and pruning each half separately let the second one erase
 * what the first had just decided to protect.
 *
 * The bar for trusting the prune is "enough of the scope's own text survives"
 * (`MIN_SURVIVING_CONTENT_CHARS`), not "any text survives at all": a page that is mostly a link
 * directory routinely carries a footer copyright line or a "Further reading." label alongside it,
 * and treating either as proof the prune was safe defeats the guard in exactly the case it exists
 * for. Below the bar, everything pruned in this call is restored.
 *
 * A fixed character count cannot fully replace judging whether surviving text is real content or
 * boilerplate (a copyright line and a short genuine sentence can be the same length) - that needs
 * the density/boilerplate pass this ticket explicitly scopes out. It is deliberately NOT relative
 * to how much was pruned either: a legitimate strip removal is very often far larger than the
 * genuine prose sitting next to it (a 40-item nav beside a one-sentence intro, or GitHub's own
 * aria-hidden tooltip spans beside a paragraph), so "survives >= removed" would roll back exactly
 * the pages this function exists to clean.
 *
 * Returns whether the prune was kept, so a caller working scope-by-scope (see `mainContentScope`)
 * knows whether THIS scope still has enough of its own content to be trusted at all.
 */
function pruneChromeFromScope($: CheerioAPI, scope: Cheerio<DomNode>): boolean {
  // Measured from the DOCUMENT root, not `scope` - `scope` is `<main>` in one branch of
  // `mainContentScope` and the whole `Document` in the other, so measuring from `scope` gave
  // `html`/`body` a free ride on a page with no `<main>` but not on one that has it, meaning
  // identical markup could get two different depth budgets depending on whether the page
  // declares a landmark. Measuring from the same fixed point in both branches makes the budget
  // mean the same thing either way.
  const documentRoot = $.root().get(0) as DomNode | undefined;
  const strips: DomNode[] = [];
  scope.find(STRIP_CONTAINER_SELECTOR).each((_index, element) => {
    // Outermost qualifying container only: removing a nested one first would leave the parent's
    // remaining siblings looking like content, and doing both is wasted work.
    if (strips.some(strip => $.contains(strip, element))) return;
    if (documentRoot && depthWithin(element, documentRoot) > MAX_STRIP_CONTAINER_DEPTH) return;
    if (documentRoot && hasProseAncestor($, element, documentRoot)) return;
    if (hasAdjacentProseText(element)) return;
    if (isControlStrip($, element)) strips.push(element);
  });

  const stripPlaceholders = strips.map(strip => {
    const placeholder = $('<div></div>');
    $(strip).replaceWith(placeholder);
    return placeholder;
  });

  const nonContentEls = scope.find(NON_CONTENT_SELECTOR).toArray();
  const nonContentPlaceholders = nonContentEls.map(element => {
    const placeholder = $('<div></div>');
    $(element).replaceWith(placeholder);
    return placeholder;
  });

  const survives = squash(scope.text()).length >= MIN_SURVIVING_CONTENT_CHARS;

  if (survives) {
    for (const placeholder of stripPlaceholders) placeholder.remove();
    for (const placeholder of nonContentPlaceholders) placeholder.remove();
  } else {
    nonContentPlaceholders.forEach((placeholder, index) => placeholder.replaceWith(nonContentEls[index]));
    stripPlaceholders.forEach((placeholder, index) => placeholder.replaceWith(strips[index]));
  }

  return survives;
}

/**
 * The scope to extract from: the document's own main-content landmark when it declares exactly one
 * AND still has enough of its own content once chrome pruning runs against it - otherwise the
 * whole document.
 *
 * This is the half of the fix that handles chrome with no other tell - a sticky sub-header of icon
 * buttons, a site footer carrying a survey and a privacy link. Trusting the page's own `<main>` also
 * answers the "real content in `<aside>`/`<footer>`" case for free, and better than a rule about
 * those tags could: an `<aside>` or `<footer>` INSIDE `main` is kept, one outside it is site chrome
 * by the page's own declaration. A document with no `main` keeps the previous whole-document scope.
 *
 * Checked twice, before AND after pruning. The first check (`main.text().trim()`) only rules out a
 * `<main>` that is LITERALLY empty - a client-rendered app shipping `<main></main>` with its real
 * content elsewhere. It does not rule out a `<main>` that is truthy for the wrong reason: a loading
 * placeholder ("Loading...") with the real article outside it, or a `<main>` whose only content IS
 * a nav bar, so pruning empties it and the real prose living outside `<main>` is never looked at.
 * The second check is `pruneChromeFromScope`'s own return value once it has actually run against
 * the candidate - if pruning leaves `<main>` without enough of its own text, `<main>` is abandoned
 * (its pruning already rolled back by that call) and the whole document is scanned instead, this
 * time seeing everything `<main>` would have hidden from it.
 */
function mainContentScope($: CheerioAPI): Cheerio<DomNode> {
  const main = $('main, [role="main"]');
  // `Cheerio<T>` is invariant in T, so the two branches' element types (Element vs Document) need
  // widening to their common supertype rather than either one being inferred.
  if (main.length === 1 && main.text().trim()) {
    const scope = main as Cheerio<DomNode>;
    if (pruneChromeFromScope($, scope)) return scope;
  }
  const root = $.root() as Cheerio<DomNode>;
  pruneChromeFromScope($, root);
  return root;
}

/**
 * Extract readable text from the WHOLE document, not just `<p>` elements. The single collector
 * this replaced was `<p>`-only and fell back to the raw HTML when it found none: on a page whose
 * content isn't inside `<p>` (an RFC page using `<pre>`) that meant the fallback fired and stored
 * markup verbatim; on a page with real substance in headings, list items, table cells or code
 * blocks alongside its `<p>`s, that content was silently dropped.
 *
 * Because it reads the whole document, page chrome that the `<p>`-only collector dropped by
 * accident now has to be dropped on purpose, or nav bars, search widgets, cookie banners, footer
 * link columns and button labels get chunked and embedded alongside the article. Two rules do
 * that - see `isControlStrip` and `NON_CONTENT_SELECTOR` for why each one is shaped the way it is -
 * applied together by `mainContentScope` (via `pruneChromeFromScope`) against whichever scope it
 * settles on, with its own rollback if pruning went too far. The strip rule MUST run before the
 * control removal, since it recognises a strip by the controls in it.
 *
 * `head` (title/meta/script/style all live there, and the caller already reads `<title>`
 * separately) plus any stray `script`/`style`/`noscript` outside it are removed before extraction,
 * so none of that reaches what gets embedded. `<pre>` content is pulled out and stashed BEFORE the
 * rest of the document is collapsed, and spliced back in verbatim afterward - it needs to skip the
 * whitespace-collapse below (a code block's leading-space indentation is meaningful, unlike prose
 * whitespace) but still needs to land in the right place relative to everything else. Table cells
 * get a trailing space (still the same row, but no longer jammed into the next cell's word); every
 * other block-level element gets a trailing newline; runs of whitespace and blank lines are then
 * collapsed. Returns `''` when nothing extractable was found, so the caller stores nothing rather
 * than falling back to raw HTML.
 */
function extractReadableText($: CheerioAPI): string {
  $('head, script, style, noscript').remove();

  // Chrome pruning (both rules) and its rollback all happen inside this call - see
  // `pruneChromeFromScope`. What comes back is the scope to read from, already pruned.
  const scope = mainContentScope($);

  scope.find('br').replaceWith('\n');

  // The stash-and-splice marker is scoped to a per-call random token, not a fixed string - this
  // function processes arbitrary third-party HTML, and a fixed marker could collide with a page's
  // own text (accidentally, or by design) and get silently overwritten with unrelated pre-block
  // content. A private-use-area delimiter (never a real character in ordinary or malicious page
  // text) plus the nonce makes an unintended match effectively impossible.
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const markerFor = (index: number) => `\uE000PRE${nonce}_${index}\uE000`;
  const markerPattern = new RegExp(`\\uE000PRE${nonce}_(\\d+)\\uE000`, 'g');

  const preBlocks: string[] = [];
  scope.find('pre').each((_index, element) => {
    const text = $(element).text();
    // An empty <pre> has nothing worth preserving - remove it outright rather than stashing an
    // empty placeholder, or a page whose only "content" is an empty <pre> would incorrectly stop
    // being classified as having no extractable text.
    if (text) {
      preBlocks.push(text);
      $(element).replaceWith(`${markerFor(preBlocks.length - 1)}\n`);
    } else {
      $(element).remove();
    }
  });

  scope.find('td, th').each((_index, cell) => {
    $(cell).after(' ');
  });
  scope.find(BLOCK_LEVEL_SELECTOR).each((_index, element) => {
    $(element).after('\n');
  });

  // The scope is `$.root()` unless the page declared a `main` - which covers the whole remaining
  // document in one call, so there is no need to special-case a missing `<body>` (malformed HTML
  // with no body tag still has its text picked up).
  const collapsed = scope
    .text()
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  // Bounds-checked defensively: every marker this function emits has a valid index, but a
  // corrupted/out-of-range match should never splice in the literal string "undefined" - leave
  // it as the harmless marker text instead.
  return collapsed.replace(markerPattern, (match, indexStr) => {
    const index = Number(indexStr);
    return index >= 0 && index < preBlocks.length ? preBlocks[index] : match;
  });
}

// Fetch and parse HTML content from a URL; returns the page title and text.
export async function fetchAndParseURL(url: string, { logger }: { logger: Logger }): Promise<ParsedContent> {
  logger.updateMetadata({ failedUrl: null });
  try {
    // Follow redirects MANUALLY so the SSRF guard runs against every address we actually fetch,
    // including the first. See `fetchWithoutRedirects`.
    let currentUrl = url;
    let response = null as Awaited<ReturnType<typeof fetchWithoutRedirects>> | null;

    // ONE budget for the whole chain, not per hop. A per-hop timeout would silently multiply the
    // worst case by MAX_REDIRECTS + 1, which matters because callers wrap this: a ~60s fetch is
    // long enough to trip MongoDB's default transaction lifetime. A single-request fetch still gets
    // the full URL_FETCH_TIMEOUT_MS, so the common case is unchanged; only chains share it. Also
    // bounds the DNS resolution above, which no axios timeout covers.
    const deadline = Date.now() + URL_FETCH_TIMEOUT_MS;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // SECURITY: Validate URL to prevent SSRF attacks.
      // This blocks requests to internal networks, cloud metadata endpoints, etc.
      const ssrfValidation = await validateUrlForFetch(currentUrl);
      if (!ssrfValidation.valid) {
        throw new Error(`URL blocked for security reasons: ${ssrfValidation.error}`);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out while following redirects for URL');
      }

      response = await fetchWithoutRedirects(currentUrl, remainingMs);

      const isRedirect = response.status >= 300 && response.status < 400;
      if (!isRedirect) break;

      const location = response.headers?.location;
      // A 3xx with no usable Location is not something to retry - treat the response as final and
      // let the parsing below do what it can with the body.
      if (typeof location !== 'string' || location.length === 0) break;

      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) while fetching URL`);
      }

      // Resolved against the CURRENT url so a relative Location is handled, and re-validated at the
      // top of the next iteration before anything is requested from it.
      currentUrl = new URL(location, currentUrl).toString();
    }

    if (!response) {
      // Unreachable: the loop always assigns before breaking. Guards the type, not a real case.
      throw new Error('URL fetch produced no response');
    }

    // Read the bytes BEFORE deciding the type. The order is deliberate and was the other way round:
    // the body is itself the most reliable format signal, so the type decision below cannot be made
    // until it is available.
    //
    // `responseType: 'arraybuffer'` gives a Buffer in Node; be tolerant of a string so a caller (or
    // a test) handing back already-decoded data still works.
    const body: Buffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data as never);

    // Type decided from what we ACTUALLY received, not from the URL the caller passed: the server's
    // Content-Type when it states one, otherwise the bytes, otherwise the FINAL url's extension.
    // `currentUrl` is the post-redirect address, so a chain that changes content type is classified
    // correctly.
    const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase();
    // Generic-binary content types carry no format signal, so fall back to the URL extension the
    // same way an absent Content-Type does - otherwise a .pdf served as application/octet-stream
    // is decoded as text. That is how S3 objects stored without an explicit ContentType and
    // `Content-Disposition: attachment` download links arrive, and treating them as text sent PDF
    // bytes through `toString('utf8')` into garbage that then got chunked and vectorized.
    const isGenericBinary =
      !contentType || contentType.includes('application/octet-stream') || contentType.includes('binary/octet-stream');
    const urlMimeType =
      contentType.includes('application/pdf') || (isGenericBinary && (isPdfUrl(currentUrl) || hasPdfMagicBytes(body)))
        ? 'application/pdf'
        : 'text/plain';

    let title: string;
    let urlContent: Buffer | string;

    if (urlMimeType === 'application/pdf') {
      urlContent = body;
      // No HTML to read a <title> from, so name it from the final url directly.
      title = lastPathSegment(currentUrl);
    } else {
      const cheerio = await import('cheerio');
      const htmlContent = body.toString('utf8');
      const $ = cheerio.load(htmlContent);
      // Fallback names the page from the FINAL url rather than the pasted one - after a redirect the
      // caller's last path segment describes a different document than the one actually fetched.
      title = $('title').text() || lastPathSegment(currentUrl);
      urlContent = extractReadableText($);
    }

    // Both URLs when they differ: the pasted one is what the user recognises, the final one is what
    // was actually fetched and parsed. Logging only the former made a redirect invisible in the log.
    // Redacted because BOTH can carry credentials - and logging the pair widened that exposure, so the
    // redaction has to cover the chain, not just the original.
    const original = redactUrlCredentials(url);
    const final = redactUrlCredentials(currentUrl);
    const fetched = original === final ? original : `${original} -> ${final}`;
    // Distinguished from the ordinary success log below: an empty extraction still returns
    // successfully (by design - see `extractReadableText`), so without this line it looks
    // identical in the logs to a normal fetch that happened to parse into real content.
    if (urlContent === '') {
      logger.log(
        `Fetched ${title} with mimetype ${urlMimeType} and parsed ${fetched}, but no extractable text was found`
      );
    } else {
      logger.log(`Fetched ${title} with mimetype ${urlMimeType} and parsed ${fetched}`);
    }
    return { title, textContent: urlContent, mimeType: urlMimeType, ext: mime.extension(urlMimeType) || null };
  } catch (error) {
    // Redacted for the same reason as the success log: this metadata is attached to the log record, and
    // a failure is exactly when a malformed credentialed URL is most likely to be the input.
    logger.updateMetadata({ failedUrl: redactUrlCredentials(url) });
    logger.debug('Error fetching or parsing URL:', error);
    throw error;
  }
}
