import { z } from 'zod';

/**
 * Push notification categories delivered to first-party native clients. The event that carries them
 * is `notification.push` (NotificationEvents.Push in apps/client/server/utils/eventBus.ts), consumed by
 * apps/workers/src/events/sendPush.ts.
 */
export const PUSH_NOTIFICATION_CATEGORIES = [
  'agent_completed',
  'agent_failed',
  'approval_needed',
  'chat_completed',
  'generation_ready',
  'agent_message',
  'session_handoff',
  'brief_ready',
] as const;

export type PushNotificationCategory = (typeof PUSH_NOTIFICATION_CATEGORIES)[number];

export const PushNotificationCategorySchema = z.enum(PUSH_NOTIFICATION_CATEGORIES);

export const PushNotificationEventSchema = z.object({
  userId: z.string().min(1),
  category: PushNotificationCategorySchema,
  title: z.string(),
  body: z.string(),
  deepLink: z.string(),
  /** Also the APNs collapse id: a later push with the same id replaces the earlier one on the device. */
  collapseId: z.string().optional(),
  questId: z.string().optional(),
  sessionId: z.string().optional(),
  destinationId: z.string().optional(),
  destinationSid: z.string().optional(),
  /** `brief_ready` only: the brief to open. A pointer; the client fetches it with its own credentials. */
  briefId: z.string().optional(),
  /**
   * `approval_needed` only: the `ts` of the pending action on `questId`. With it, the push carries the
   * approve/deny action identifiers so a client can answer from the notification itself.
   */
  pendingActionTs: z.number().int().positive().optional(),
  /**
   * `approval_needed` only: marks this event as the clearing push for an approval that has been handled
   * (the value is how it ended). It reuses the original collapse id so it replaces the delivered approval
   * on the lock screen, and carries no action buttons and no sound.
   */
  approvalResolved: z.enum(['approved', 'denied', 'lapsed']).optional(),
  /**
   * `brief_ready` only, set when the brief holds exactly one decision: its kind, so the push selects a
   * notification category with approve/deny or reply actions. The client re-fetches the brief before acting.
   */
  briefAction: z.enum(['approval', 'question']).optional(),
  /**
   * `agent_completed` only: the one summary sent for runs finished during a busy block whose block brief did
   * not land (notifyHeldBlockRuns in packages/server-utils/src/briefs). Never held itself.
   */
  busyBlockDigest: z.literal(true).optional(),
  /**
   * `brief_ready` of a busy-block brief only: the push categories the brief reports. deliverPush in
   * apps/workers/src/events/sendPush.ts holds the push when isBlockEndPushHeld says so.
   */
  blockEndCategories: z.array(PushNotificationCategorySchema).max(PUSH_NOTIFICATION_CATEGORIES.length).optional(),
});

export type PushNotificationEvent = z.infer<typeof PushNotificationEventSchema>;

/**
 * Per-user opt-outs, stored at `user.preferences.pushNotifications`. A missing key means enabled, so
 * a category added later is on for everyone until they turn it off.
 */
export const PushNotificationPreferencesSchema = z.object({
  agent_completed: z.boolean().optional(),
  agent_failed: z.boolean().optional(),
  approval_needed: z.boolean().optional(),
  chat_completed: z.boolean().optional(),
  generation_ready: z.boolean().optional(),
  agent_message: z.boolean().optional(),
  session_handoff: z.boolean().optional(),
  brief_ready: z.boolean().optional(),
});

export type PushNotificationPreferences = z.infer<typeof PushNotificationPreferencesSchema>;

/**
 * Categories not delivered while the user is inside a synced calendar busy block: agent run results, which
 * the block brief lists once the block ends. The rest stay live because the brief cannot surface them
 * (agent_message writes no run), the user is waiting on them (approval_needed), or asked for them in the
 * foreground.
 */
export const BUSY_BLOCK_HELD_CATEGORIES = [
  'agent_completed',
  'agent_failed',
] as const satisfies readonly PushNotificationCategory[];

export function isHeldDuringBusyBlock(category: PushNotificationCategory): boolean {
  return (BUSY_BLOCK_HELD_CATEGORIES as readonly PushNotificationCategory[]).includes(category);
}

export function isPushCategoryEnabled(
  preferences: PushNotificationPreferences | null | undefined,
  category: PushNotificationCategory
): boolean {
  return preferences?.[category] !== false;
}

/** The categories a user can teach the block-end push to stay quiet about. */
export const INTERRUPTION_FEEDBACK_CATEGORIES = BUSY_BLOCK_HELD_CATEGORIES;

/**
 * Stored at `user.preferences.interruptionFeedback`; `true` means do not push about that category once a
 * busy block ends. The brief is still composed and listed. Must stay in sync with the interruptionFeedback
 * sub-schema in packages/database/src/models/auth/UserModel.ts.
 */
export const InterruptionFeedbackSchema = z
  .object({
    agent_completed: z.boolean().optional(),
    agent_failed: z.boolean().optional(),
  })
  .strict();

export type InterruptionFeedback = z.infer<typeof InterruptionFeedbackSchema>;

function isInterruptionFeedbackCategory(
  category: PushNotificationCategory
): category is (typeof INTERRUPTION_FEEDBACK_CATEGORIES)[number] {
  return (INTERRUPTION_FEEDBACK_CATEGORIES as readonly PushNotificationCategory[]).includes(category);
}

/**
 * Whether the block-end brief push is held: only when every category it reports is one the user taught
 * to stay quiet. A decision or any other content keeps the push live, and absent feedback never holds.
 */
export function isBlockEndPushHeld(
  feedback: InterruptionFeedback | null | undefined,
  categories: readonly PushNotificationCategory[]
): boolean {
  return categories.length > 0 && categories.every(c => isInterruptionFeedbackCategory(c) && feedback?.[c] === true);
}
