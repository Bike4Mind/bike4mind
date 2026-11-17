import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { Logger } from '@bike4mind/observability';
import { slackFeedbackChannelIdSchema, slackFeedbackUserIdSchema } from '@client/app/utils/slackFeedbackIds';

export function isFeedbackChannelEligible(
  channel:
    | {
        is_member?: boolean;
        is_im?: boolean;
        is_mpim?: boolean;
        is_shared?: boolean;
        is_org_shared?: boolean;
        is_ext_shared?: boolean;
        is_pending_ext_shared?: boolean;
      }
    | undefined
): boolean {
  return (
    !!channel?.is_member &&
    !channel.is_im &&
    !channel.is_mpim &&
    !channel.is_shared &&
    !channel.is_org_shared &&
    !channel.is_ext_shared &&
    !channel.is_pending_ext_shared
  );
}

const destinationSchema = z
  .array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
      organizationId: z.string().min(1),
      url: z.url().refine(value => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
      }),
      secret: z.string().min(32),
    })
  )
  .max(100);

export function feedbackDestinations(raw: string | undefined) {
  if (!raw || raw === 'not-configured') return [];
  try {
    const parsed = destinationSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || new Set(parsed.data.map(d => d.id)).size !== parsed.data.length) {
      Logger.warn('Slack feedback destination configuration is invalid');
      return [];
    }
    return parsed.data;
  } catch {
    Logger.warn('Slack feedback destination configuration is not valid JSON');
    return [];
  }
}

export const feedbackId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function signFeedback(body: string, timestamp: string, secret: string, purpose: 'forward' | 'status') {
  return `v1=${createHmac('sha256', secret).update(`v1:${purpose}:${timestamp}:${body}`).digest('hex')}`;
}

export function verifyFeedback(body: string, timestamp: unknown, signature: unknown, secret: string) {
  if (typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp) || typeof signature !== 'string') return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(signFeedback(body, timestamp, secret, 'status'));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const reactionSchema = z.object({
  type: z.literal('reaction_added'),
  reaction: z.string().max(64),
  user: slackFeedbackUserIdSchema,
  item: z.object({
    type: z.literal('message'),
    channel: slackFeedbackChannelIdSchema,
    ts: z.string().regex(/^\d+\.\d+$/),
  }),
});

export const statusSchema = z.strictObject({
  deliveryId: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['filed', 'in_progress', 'fixed_on_prod', 'rejected']),
});

export const statusLabels = {
  filed: 'Feedback filed.',
  in_progress: 'Feedback is being worked on.',
  fixed_on_prod: 'Feedback fixed on production.',
  rejected: 'Feedback closed without a change.',
};
