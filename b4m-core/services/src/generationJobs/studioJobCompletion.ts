import {
  STUDIO_COMPLETION_TITLE_MAX_CHARS,
  studioCompletionLink,
  type GenerationJobKind,
  type StudioCompletionMedium,
  type StudioJobCompletedEvent,
} from '@bike4mind/common';
import type { GroupCompletionSubscriber } from './groupCompletion';

const MEDIUM_BY_KIND: Record<GenerationJobKind, StudioCompletionMedium> = {
  image: 'image',
  video: 'video',
  music: 'music',
};

const UNTITLED = 'Untitled';
const ELLIPSIS = '...';

/** The prompt as a one-line label: whitespace collapsed, cut on a word where one is near the limit. */
export const studioCompletionTitle = (prompt: string | undefined): string => {
  const flat = (prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return UNTITLED;
  if (flat.length <= STUDIO_COMPLETION_TITLE_MAX_CHARS) return flat;
  const room = STUDIO_COMPLETION_TITLE_MAX_CHARS - ELLIPSIS.length;
  const cut = flat.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > room / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}${ELLIPSIS}`;
};

// A cutout's prompt is the server's fixed instruction, so it is named for what it is; matches ImageJobCard's caption.
const groupTitle = (payload: object & { request: { prompt?: string } }, readyCount: number): string => {
  if ('purpose' in payload && payload.purpose === 'cutout') {
    return readyCount > 0 ? 'Background removed' : 'Background removal';
  }
  return studioCompletionTitle(payload.request.prompt);
};

/** Announces a finished Studio group as `studio.job.completed`, the event every Studio surface subscribes to. */
export const studioCompletionSubscriber = (
  publish: (event: StudioJobCompletedEvent) => Promise<void>
): GroupCompletionSubscriber => ({
  name: 'studio_event',
  wants: job => job.source === 'studio',
  deliver: async ({ groupId, members, anchor, readyCount, failedCount, cancelledCount, completedAt }) => {
    const medium = MEDIUM_BY_KIND[anchor.kind];
    await publish({
      version: 1,
      userId: anchor.requestedBy,
      groupId,
      medium,
      totalCount: members.length,
      readyCount,
      failedCount,
      cancelledCount,
      title: groupTitle(anchor.payload, readyCount),
      link: studioCompletionLink(medium, groupId),
      completedAt: completedAt.toISOString(),
    });
  },
});
