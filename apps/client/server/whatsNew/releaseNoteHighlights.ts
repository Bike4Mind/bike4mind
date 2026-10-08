import { releaseNoteRepository, type IReleaseNoteDocument } from '@bike4mind/database';
import type { ReleaseNoteCategory } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { findDeniedInNote, loadReleaseNotesConfig } from '@server/releaseNotes/adminReleaseNotes';
import type { ModalForHighlights } from './whatsNewHighlights.types';

const CATEGORY_HEADINGS: Array<[ReleaseNoteCategory, string]> = [
  ['new', 'New'],
  ['improved', 'Improved'],
  ['fixed', 'Fixed'],
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a highlights range end; a bare YYYY-MM-DD covers that whole UTC day. */
export const parseHighlightsEndDate = (value: string): Date =>
  new Date(DATE_ONLY.test(value) ? `${value}T23:59:59.999Z` : value);

/** Adapts a release note into the entry the weekly highlights prompt summarizes. */
export function releaseNoteToHighlightsEntry(note: IReleaseNoteDocument): ModalForHighlights {
  const sections = [note.summary.trim()].filter(Boolean);
  for (const [category, heading] of CATEGORY_HEADINGS) {
    // importance 1 is the most notable, so ascending order leads with it
    const items = note.items.filter(item => item.category === category).sort((a, b) => a.importance - b.importance);
    if (items.length === 0) continue;
    sections.push(`${heading}:\n${items.map(item => `- ${item.text}`).join('\n')}`);
  }
  return {
    _id: note.id,
    title: note.headline.trim() || note.releaseTag,
    subtitle: note.releaseTag,
    description: sections.join('\n\n'),
    createdAt: note.publishAt,
  };
}

// Bounds the highlights prompt; a busier range is summarized from its newest notes only.
export const HIGHLIGHTS_NOTE_LIMIT = 50;

export type HighlightsReleaseNotes =
  { kind: 'disabled' } | { kind: 'ok'; entries: ModalForHighlights[]; truncated: boolean };

/**
 * The local release notes a highlights run summarizes. A disabled or malformed config and denylisted notes
 * are handled as in the local branch of `pages/api/v1/whats-new.ts`.
 */
export async function loadHighlightsReleaseNotes(
  { start, end, now = new Date() }: { start: Date; end: Date; now?: Date },
  logger: Logger
): Promise<HighlightsReleaseNotes> {
  const { config, malformed } = await loadReleaseNotesConfig(logger);
  if (malformed || !config.enabled) return { kind: 'disabled' };

  // One past the limit, so a range that overflows it is reported rather than silently cut.
  const found = await releaseNoteRepository.findPublishedBetween(start, end, now, HIGHLIGHTS_NOTE_LIMIT + 1);
  const truncated = found.length > HIGHLIGHTS_NOTE_LIMIT;
  if (truncated) {
    logger.warn('[whats-new-highlights] range holds more release notes than one run summarizes', {
      limit: HIGHLIGHTS_NOTE_LIMIT,
    });
  }
  const entries = found
    .slice(0, HIGHLIGHTS_NOTE_LIMIT)
    .filter(note => {
      if (!findDeniedInNote(note, config.denylist)) return true;
      logger.warn('[whats-new-highlights] withholding a release note that matches the denylist', { id: note.id });
      return false;
    })
    .map(releaseNoteToHighlightsEntry);
  return { kind: 'ok', entries, truncated };
}
