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
 * Categories not delivered while the user is inside a synced calendar busy block: run and session
 * content the block brief covers once the block ends. The rest stay live because the user is waiting on
 * them (approval_needed) or asked for them in the foreground.
 */
export const BUSY_BLOCK_HELD_CATEGORIES = [
  'agent_completed',
  'agent_failed',
  'agent_message',
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
