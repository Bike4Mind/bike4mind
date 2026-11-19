import {
  STUDIO_COMPLETION_TITLE_MAX_CHARS,
  studioCompletionLink,
  generationJobPrompt,
  type GenerationJobKind,
  type StudioCompletionMedium,
  type StudioJobCompletedEvent,
} from '@bike4mind/common';
import type { GroupCompletionSubscriber } from './groupCompletion';

// A render reports on the Productions export panel, not as a Studio Create completion.
type AnnouncedKind = Exclude<GenerationJobKind, 'render'>;

const MEDIUM_BY_KIND: Record<AnnouncedKind, StudioCompletionMedium> = {
  image: 'image',
  video: 'video',
  music: 'music',
  speech: 'speech',
  sound_effect: 'sound-effects',
  // A Scene is a rendered video clip.
  compose: 'video',
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

// These finish while the requester waits on the synchronous route, already looking at the result.
const INLINE_KINDS: readonly GenerationJobKind[] = ['speech', 'sound_effect'];

// A cutout's prompt is the server's fixed instruction, so it is named for what it is; matches ImageJobCard's caption.
const groupTitle = (anchor: Parameters<typeof generationJobPrompt>[0], readyCount: number): string => {
  if ('purpose' in anchor.payload && anchor.payload.purpose === 'cutout') {
    return readyCount > 0 ? 'Background removed' : 'Background removal';
  }
  return studioCompletionTitle(generationJobPrompt(anchor));
};

/** Announces a finished Studio group as `studio.job.completed`, the event every Studio surface subscribes to. */
export const studioCompletionSubscriber = (
  publish: (event: StudioJobCompletedEvent) => Promise<void>
): GroupCompletionSubscriber => ({
  name: 'studio_event',
  wants: job => job.source === 'studio' && !INLINE_KINDS.includes(job.kind) && job.kind !== 'render',
  deliver: async ({ groupId, members, anchor, readyCount, failedCount, cancelledCount, completedAt }) => {
    if (anchor.kind === 'render') return;
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
      title: groupTitle(anchor, readyCount),
      link: studioCompletionLink(medium, groupId),
      completedAt: completedAt.toISOString(),
    });
  },
});
