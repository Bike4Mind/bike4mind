import {
  findDenied,
  RELEASE_NOTES_SCHEMA_VERSION,
  scrubCustomerText,
  type ReleaseNote,
  type ReleaseNotesConfig,
  type ReleaseNotesJobPayload,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { MAX_HEADLINE_CHARS } from './limits';
import type { ReleaseNoteDraft } from './generate';

const MS_PER_HOUR = 60 * 60 * 1000;

const FEAT_OR_FIX_TITLE = /^(?:feat|fix)(?:\([^)]*\))?!?:/i;

// Marketing filler the model reaches for when it has nothing specific to say. Keep in sync with the
// headline rules in buildEditorialPrompt (generate.ts).
const HYPE_WORDS =
  /\b(?:exciting|excited|amazing|awesome|incredible|thrilled|powerful|seamless(?:ly)?|revolutionary|game[- ]chang\w*|cutting[- ]edge|next[- ]level|supercharg\w*|unleash\w*|delight\w*)\b/i;
const GENERIC_HEADLINE =
  /^(?:bug fixes|minor (?:updates|fixes|improvements|changes)|various (?:updates|fixes|improvements|changes)|what'?s new)[.!]?$|\b(?:new features|(?:updates|fixes|improvements|enhancements) and (?:(?:other|more|minor|general|performance|various) )?(?:bug fixes|fixes|improvements|enhancements|new features)|latest (?:update|release)|this release|(?:your |our |the )?ai workspace)\b/i;

/** Reasons the copy reads as generic or hype; empty when it is specific and plain. */
export function findGenericCopy(field: 'headline' | 'summary', text: string): string[] {
  const reasons: string[] = [];
  const hype = text.match(HYPE_WORDS);
  if (hype) reasons.push(`the ${field} must not use hype words like "${hype[0]}"`);
  if (text.includes('!')) reasons.push(`the ${field} must not use exclamation marks`);
  if (field === 'headline') {
    const generic = text.match(GENERIC_HEADLINE);
    if (generic) {
      reasons.push(
        `the headline must name the single most important change in concrete terms, not generic words like "${generic[0]}"`
      );
    }
  }
  return reasons;
}

/**
 * Headline built from the items when the model cannot write a specific one: the most important item that
 * already reads as a headline, else the most important item.
 */
function headlineFromItems(items: ReleaseNote['items'], logger: Logger): string {
  const ordered = [...items].sort((a, b) => a.importance - b.importance);
  // Prefer an item that already reads as a headline, so the fallback does not reintroduce hype or an "!".
  const pick = ordered.find(item => findGenericCopy('headline', item.text).length === 0);
  if (!pick) {
    logger.warn('[releaseNotes] no item reads as a specific headline; using the most important one anyway', {
      reasons: findGenericCopy('headline', ordered[0].text),
    });
  }
  const text = (pick ?? ordered[0]).text.replace(/[.!\s]+$/, '');
  if (text.length <= MAX_HEADLINE_CHARS) return text;
  // trimEnd, then drop a lone high surrogate so the cut never ends on half of an astral character.
  const cut = text
    .slice(0, MAX_HEADLINE_CHARS - 3)
    .trimEnd()
    .replace(/[\uD800-\uDBFF]$/, '');
  return `${cut}...`;
}

export type FinalizeResult = { kind: 'repair'; reasons: string[] } | { kind: 'ok'; note: ReleaseNote };

/**
 * Turns a generated draft into a storable note: scrub, denylist, embargo and status. A denylist hit in
 * an item drops that item; a hit in the headline or summary returns `repair` so the caller can regenerate.
 * Generic or hype copy also returns `repair`, except on the `lastAttempt`, where a generic headline is
 * rebuilt from the items and a hype summary is dropped, so the release still gets a note.
 */
export function finalizeReleaseNote(
  draft: ReleaseNoteDraft,
  payload: Pick<ReleaseNotesJobPayload, 'releaseTag' | 'deployedSha' | 'deployedAt' | 'prs'>,
  config: Pick<ReleaseNotesConfig, 'embargoHours' | 'denylist'>,
  logger: Logger,
  { lastAttempt = false }: { lastAttempt?: boolean } = {}
): FinalizeResult {
  const denylist = config.denylist.map(term => term.trim().toLowerCase()).filter(Boolean);
  let headline = scrubCustomerText(draft.headline);
  let summary = scrubCustomerText(draft.summary);

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

  const headlineReasons = findGenericCopy('headline', headline);
  const summaryReasons = findGenericCopy('summary', summary);
  if ((headlineReasons.length || summaryReasons.length) && items.length) {
    if (!lastAttempt) return { kind: 'repair', reasons: [...headlineReasons, ...summaryReasons] };
    logger.warn('[releaseNotes] copy still generic after a rewrite; rebuilding the headline from the items', {
      releaseTag: payload.releaseTag,
      reasons: [...headlineReasons, ...summaryReasons],
    });
    if (headlineReasons.length) headline = headlineFromItems(items, logger);
    // The items carry the detail, so no summary beats a hype one.
    if (summaryReasons.length) summary = '';
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
