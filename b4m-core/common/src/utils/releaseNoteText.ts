// Customer-copy hygiene shared by the workers release-notes generator and the admin release-notes edit route.
// Leak prevention only: this does not sanitize HTML or script URLs, so renderers must treat the text as untrusted.
// Two or more digits so ordinary copy such as "#1" and "GPT-4" survives.
const PR_REF = /^#\d{2,}$/;
const TICKET_KEY = /^[A-Za-z]{2,10}-\d{2,}$/;
// Standards and everyday terms shaped like a ticket key (AES-256, utf-16, top-10).
const NOT_A_TICKET = /^(?:aes|base|covid|ipv|iso|rsa|sha|top|utf)-\d+$/i;
const CROSS_REPO_REF = /^[\w.-]+\/[\w.-]+#\d+$/;
const ANY_URL = /^(?:[a-z][a-z\d+.-]*:\/\/|www\.)/i;
const GITHUB_URL = /^github\.com\//i;
// Needs a path, and a code extension is not a TLD, so "Node.js/Deno" and "e.g." survive.
const BARE_DOMAIN_URL =
  /^[a-z\d-]+(?:\.[a-z\d-]+)*\.(?!(?:[cm]?[jt]sx?|json|md|py|go|sh|css|html|ya?ml)\/)[a-z]{2,}\//i;
const REPO_PATH_ROOT = /^(?:apps|packages|b4m-core|infra|scripts|src|\.github)\//;
const CODE_FILE_EXT = /\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|go|sh|css|scss|html)$/i;

const OPENERS = '([{"\'`';
const CLOSERS = ')]}"\'`';
const SENTENCE_PUNCT = '.,;:!?';

const isInternalReference = (core: string): boolean =>
  PR_REF.test(core) ||
  (TICKET_KEY.test(core) && !NOT_A_TICKET.test(core)) ||
  CROSS_REPO_REF.test(core) ||
  ANY_URL.test(core) ||
  GITHUB_URL.test(core) ||
  BARE_DOMAIN_URL.test(core) ||
  (core.includes('/') && (REPO_PATH_ROOT.test(core) || CODE_FILE_EXT.test(core)));

/**
 * Removes PR refs (incl. owner/repo#N), URLs, ticket keys and repo paths from customer copy. Works per whitespace
 * token so every check is anchored and linear; surrounding brackets go with the reference while
 * sentence punctuation stays.
 */
export function scrubCustomerText(text: string): string {
  // Zero-width format characters and "# 123" would otherwise split a reference across tokens; splitting "](" makes
  // the URL half of a markdown link its own token.
  const out = text
    .replace(/\p{Cf}/gu, '')
    .replace(/#\s+(?=\d)/g, '#')
    .replace(/\]\(/g, '] (')
    .split(/(\s+)/)
    .map(token => {
      let start = 0;
      let end = token.length;
      while (start < end && OPENERS.includes(token[start])) start++;
      while (end > start && (CLOSERS.includes(token[end - 1]) || SENTENCE_PUNCT.includes(token[end - 1]))) end--;
      if (start === end || !isInternalReference(token.slice(start, end))) return token;
      return [...token.slice(end)].filter(c => SENTENCE_PUNCT.includes(c)).join('');
    })
    .join('');
  return out
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .replace(/\( ?\)/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// Cyrillic and Greek letters that render like Latin ones, paired by position with their Latin twin.
const LOOKALIKE_SOURCE =
  '\u0430\u0435\u043e\u0440\u0441\u0445\u0443\u0456\u0458\u0455\u0501\u04bb\u04cf\u03b1\u03bf\u03bd\u03b9\u03ba\u03c1\u03c4\u03c5';
const LOOKALIKE_LATIN = 'aeopcxyijsdhlaovikptu';
const LOOKALIKE = new RegExp(`[${LOOKALIKE_SOURCE}]`, 'g');

// Compares letters and digits only, so "A.C.M.E", "Ac-me" and "A C M E" all match a denylisted "acme". Lookalike
// letters and sharp s are folded too; this is a best-effort net, not a full Unicode confusables skeleton.
const foldForDenylist = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/\u03c2/g, '\u03c3')
    .replace(LOOKALIKE, c => LOOKALIKE_LATIN[LOOKALIKE_SOURCE.indexOf(c)])
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Returns the first denylist term the text contains after folding case, punctuation and lookalike letters. */
export const findDenied = (text: string, denylist: string[]): string | undefined => {
  const folded = foldForDenylist(text);
  return denylist.find(term => {
    const foldedTerm = foldForDenylist(term);
    return foldedTerm.length > 0 && folded.includes(foldedTerm);
  });
};
