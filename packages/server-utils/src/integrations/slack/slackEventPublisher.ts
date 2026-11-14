import type { QuickAskRequestedDetail } from '@bike4mind/slack';
import { z } from 'zod';
import { LLMEvents, SlackEvents } from '../../utils/eventBus';

const AcceptedQuickAskSchema = z.object({
  FailedEntryCount: z.literal(0).optional(),
  Entries: z.tuple([
    z.object({
      EventId: z.string().min(1),
      ErrorCode: z.never().optional(),
      ErrorMessage: z.never().optional(),
    }),
  ]),
});

/** Actual Slack DI binding: a fulfilled SDK call alone does not prove event admission. */
export const slackEventPublisher = {
  LLMEvents: {
    ...LLMEvents,
    CompletionStart: LLMEvents.SlackCompletionStart,
  },
  SlackEvents: {
    ...SlackEvents,
    QuickAskRequested: {
      publish: async (detail: QuickAskRequestedDetail): Promise<void> => {
        // This subscription has an explicit self-host parity gap, not a working queue consumer.
        if (process.env.B4M_SELF_HOST === 'true') {
          throw new Error('Slack Quick Ask requires the hosted event worker');
        }
        const result = await SlackEvents.QuickAskRequested.publish(detail);
        if (!AcceptedQuickAskSchema.safeParse(result).success) {
          throw new Error('Quick Ask event was not accepted by EventBridge');
        }
      },
    },
  },
};
