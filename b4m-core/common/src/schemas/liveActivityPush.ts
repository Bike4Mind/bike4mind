import { z } from 'zod';

/**
 * Live activity updates for first-party native clients. The event that carries them is
 * `notification.liveActivity` (NotificationEvents.LiveActivity in apps/client/server/utils/eventBus.ts),
 * consumed by apps/workers/src/events/sendPush.ts, which routes it to the `liveActivity` push tokens
 * registered for the quest.
 *
 * `LiveActivityContentStateSchema` is the activity's `content-state` as the client decodes it: keep the
 * keys in sync with the client's ContentState type.
 */
export const LiveActivityContentStateSchema = z.object({
  /** Run phase: `running`, `paused`, `approval_needed`, `completed` or `failed`. */
  status: z.string().min(1),
  /** Short human label for the current stage, e.g. the agent's latest status line. */
  stageLabel: z.string().optional(),
  /** Fraction complete, 0..1; omitted when the run has no measurable total. */
  progress: z.number().min(0).max(1).optional(),
  errored: z.boolean().optional(),
});

export type LiveActivityContentState = z.infer<typeof LiveActivityContentStateSchema>;

export const LiveActivityPushEventSchema = z.object({
  userId: z.string().min(1),
  /** The activity is keyed by quest: the client registers its activity push token with this id. */
  questId: z.string().min(1),
  event: z.enum(['update', 'end']),
  contentState: LiveActivityContentStateSchema,
  /** Unix seconds after which the client marks the activity stale (APNs `stale-date`). */
  staleDate: z.number().int().positive().optional(),
  /** Unix seconds at which an ended activity leaves the lock screen (APNs `dismissal-date`). */
  dismissalDate: z.number().int().positive().optional(),
});

export type LiveActivityPushEvent = z.infer<typeof LiveActivityPushEventSchema>;
