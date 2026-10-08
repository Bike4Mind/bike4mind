import {
  RELEASE_NOTES_SCHEMA_VERSION,
  type ReleaseNote,
  type ReleaseNotesConfig,
  type ReleaseNotesJobPayload,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ReleaseNoteDraft } from './generate';

const MS_PER_HOUR = 60 * 60 * 1000;

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
const FEAT_OR_FIX_TITLE = /^(?:feat|fix)(?:\([^)]*\))?!?:/i;

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

const findDenied = (text: string, denylist: string[]): string | undefined => {
  const folded = foldForDenylist(text);
  return denylist.find(term => {
    const foldedTerm = foldForDenylist(term);
    return foldedTerm.length > 0 && folded.includes(foldedTerm);
  });
};

export type FinalizeResult = { kind: 'repair'; reasons: string[] } | { kind: 'ok'; note: ReleaseNote };

/**
 * Turns a generated draft into a storable note: scrub, denylist, embargo and status. A denylist hit in
 * an item drops that item; a hit in the headline or summary returns `repair` so the caller can regenerate.
 */
export function finalizeReleaseNote(
  draft: ReleaseNoteDraft,
  payload: Pick<ReleaseNotesJobPayload, 'releaseTag' | 'deployedSha' | 'deployedAt' | 'prs'>,
  config: Pick<ReleaseNotesConfig, 'embargoHours' | 'denylist'>,
  logger: Logger
): FinalizeResult {
  const denylist = config.denylist.map(term => term.trim().toLowerCase()).filter(Boolean);
  const headline = scrubCustomerText(draft.headline);
  const summary = scrubCustomerText(draft.summary);

  const reasons: string[] = [];
  for (const [field, value] of [
    ['headline', headline],
    ['summary', summary],
  ] as const) {
    const term = findDenied(value, denylist);
    if (term) reasons.push(`the ${field} must not mention "${term}"`);
  }
  if (reasons.length) return { kind: 'repair', reasons };

  let dropped = 0;
  const items = draft.items.flatMap(item => {
    const text = scrubCustomerText(item.text);
    if (!text || findDenied(text, denylist)) {
      dropped++;
      return [];
    }
    return [{ ...item, text }];
  });
  if (dropped) {
    logger.warn(`[releaseNotes] dropped ${dropped} item(s) that were empty after scrubbing or hit the denylist`, {
      releaseTag: payload.releaseTag,
    });
  }

  if (items.length === 0 && payload.prs.some(pr => FEAT_OR_FIX_TITLE.test(pr.title))) {
    logger.warn('[releaseNotes] no customer-facing items although the release has feat/fix PRs; storing as hidden', {
      releaseTag: payload.releaseTag,
    });
  }

  return {
    kind: 'ok',
    note: {
      releaseTag: payload.releaseTag,
      deployedSha: payload.deployedSha,
      deployedAt: payload.deployedAt,
      headline,
      summary,
      items,
      audience: 'public',
      status: items.length ? 'scheduled' : 'hidden',
      publishAt: new Date(payload.deployedAt.getTime() + config.embargoHours * MS_PER_HOUR),
      editedAt: null,
      schemaVersion: RELEASE_NOTES_SCHEMA_VERSION,
    },
  };
}
