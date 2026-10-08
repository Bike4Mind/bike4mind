import type { IModalDocument, PublicReleaseNote } from '@bike4mind/common';
import { formatDisplayDate } from '@client/app/utils/dateUtils';
import { groupReleaseNoteItems } from '@client/app/utils/releaseNoteItems';

// Seen-tracking keys on modal._id, so the prefix keeps a note's id from colliding with a Modal ObjectId.
export const RELEASE_NOTE_SLIDE_PREFIX = 'release-note:';

const buildDescription = (note: PublicReleaseNote): string => {
  const sections = [note.summary.trim()].filter(Boolean);
  for (const { heading, items } of groupReleaseNoteItems(note.items)) {
    sections.push(`**${heading}**\n\n${items.map(item => `- ${item.text}`).join('\n')}`);
  }
  return sections.join('\n\n');
};

/** Adapts a public release note into the shape the What's New slider renders and seen-tracks. */
export function releaseNoteToModal(note: PublicReleaseNote): IModalDocument {
  const id = `${RELEASE_NOTE_SLIDE_PREFIX}${note.id}`;
  const publishedAt = new Date(note.published_at);
  const date = formatDisplayDate(publishedAt);
  return {
    _id: id,
    id,
    isBanner: false,
    title: note.headline.trim() || note.release_tag,
    subtitle: date ? `${date} \u00b7 ${note.release_tag}` : note.release_tag,
    description: buildDescription(note),
    tags: ['whats-new', 'release-note'],
    priority: 0,
    closeButton: true,
    agreeButton: false,
    enabled: true,
    startDate: null,
    endDate: null,
    numberOfAgrees: null,
    numberOfViews: { type: 'firstTimeView', value: 0, threshold: 1, tags: [] },
    imageUrl: null,
    images: null,
    textMessage: null,
    generationMetadata: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  };
}
