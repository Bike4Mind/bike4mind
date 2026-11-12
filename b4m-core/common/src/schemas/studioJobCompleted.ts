import { z } from 'zod';

/**
 * `studio.job.completed`: one event per finished Studio group (the N takes of one "make N" image request share a
 * groupId; a video or music job is a group of one). Built for every client that tells the user their results are
 * ready: the web toast today, desktop native notifications and mobile push later. A breaking change bumps `version`
 * so an older consumer can skip what it cannot read.
 *
 * Producer: emitStudioJobCompletion (b4m-core/services/src/generationJobs/studioJobCompletion.ts).
 * Consumer: apps/workers/src/events/studioJobCompleted.ts, which relays it to the user's open sessions.
 */
export const STUDIO_JOB_COMPLETED_EVENT = 'studio.job.completed';

/** Matches the Studio route's `/studio/$modality` param, so a consumer can build the link without a mapping. */
export const STUDIO_COMPLETION_MEDIA = ['image', 'video', 'music', 'speech', 'sound-effects'] as const;
export type StudioCompletionMedium = (typeof STUDIO_COMPLETION_MEDIA)[number];

export const STUDIO_COMPLETION_TITLE_MAX_CHARS = 60;

const count = z.number().int().nonnegative();

/** What a client renders: carries no recipient, so it is the shape relayed to the browser as-is. */
export const StudioJobCompletionSchema = z.object({
  version: z.literal(1),
  groupId: z.string().min(1),
  medium: z.enum(STUDIO_COMPLETION_MEDIA),
  totalCount: z.number().int().positive(),
  readyCount: count,
  /** Failed or blocked takes. Takes the user cancelled are counted apart, since they are not a failure. */
  failedCount: count,
  cancelledCount: count,
  /** Short label for the batch (the prompt today), plain text and never empty. */
  title: z.string().min(1).max(STUDIO_COMPLETION_TITLE_MAX_CHARS),
  /** App-relative path that opens the takes, e.g. `/studio/image?group=<groupId>`; native clients map it. */
  link: z.string().startsWith('/studio/'),
  completedAt: z.iso.datetime(),
});
export type StudioJobCompletion = z.infer<typeof StudioJobCompletionSchema>;

export const StudioJobCompletedEventSchema = StudioJobCompletionSchema.extend({
  userId: z.string().min(1),
});
export type StudioJobCompletedEvent = z.infer<typeof StudioJobCompletedEventSchema>;

/** The link target for a group: the medium's Studio page, narrowed to the group. */
export const studioCompletionLink = (medium: StudioCompletionMedium, groupId: string): string =>
  `/studio/${medium}?group=${encodeURIComponent(groupId)}`;
