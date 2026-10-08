import {
  findDenied,
  RELEASE_NOTES_SCHEMA_VERSION,
  scrubCustomerText,
  type ReleaseNote,
  type ReleaseNotesConfig,
  type ReleaseNotesJobPayload,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { ReleaseNoteDraft } from './generate';

const MS_PER_HOUR = 60 * 60 * 1000;

const FEAT_OR_FIX_TITLE = /^(?:feat|fix)(?:\([^)]*\))?!?:/i;

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
