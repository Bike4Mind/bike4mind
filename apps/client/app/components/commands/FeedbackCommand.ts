import {
  FeedbackStatus,
  FeedbackType,
  IChatHistoryItem,
  IChatHistoryItemDocument,
  ISessionDocument,
} from '@bike4mind/common';
import { QueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { createFeedbackOnServer } from '@client/app/utils/feedbackAPICalls';

export type FeedbackCommandArgs = {
  params: string;
  userId: string;
  username?: string;
  userEmail?: string;
  currentSession: ISessionDocument | null;
  queryClient: QueryClient;
  addMessageToSession?: (message: IChatHistoryItem) => void | Promise<void>;
};

type SessionQuestPages = {
  pages: Array<{ data: IChatHistoryItemDocument[] }>;
};

export const FEEDBACK_COMMAND_USAGE =
  'Tell us what is on your mind: `/feedback the retrieval keeps missing my uploaded specs`';

/**
 * Newest real quest in the session, as the cache has it at the moment the report is written.
 * Optimistic bubbles are skipped: their ids are client-generated and mean nothing to the server,
 * which drops any claim it cannot re-read. Ordering is by timestamp rather than page position so
 * this does not depend on setOptimisticQueryData's prepend behaviour staying newest-first.
 */
export function findLatestQuestId(queryClient: QueryClient, sessionId: string): string | undefined {
  const cached = queryClient.getQueryData<SessionQuestPages>(['quests', 'session', sessionId]);
  if (!cached?.pages) return undefined;

  let latest: { id: string; at: number } | undefined;
  for (const page of cached.pages) {
    for (const quest of page.data ?? []) {
      if (typeof quest.id !== 'string' || quest.id.startsWith('optimistic-quest-')) continue;
      const at = new Date(quest.createdAt ?? quest.timestamp ?? 0).getTime();
      if (!latest || at >= latest.at) latest = { id: quest.id, at };
    }
  }
  return latest?.id;
}

function outcomeMessage(result: Awaited<ReturnType<typeof createFeedbackOnServer>>): {
  text: string;
  level: 'success' | 'warning';
} {
  // Same ladder as the help modal: a report the team never hears about, or whose words were
  // dropped, must not read as a plain success.
  if (result.contentStored === false) {
    return {
      text: 'Your feedback was received, but we could not save the message text - please try again.',
      level: 'warning',
    };
  }
  const deliveryFailed = result.delivery?.delivered === false;
  if (result.contentTruncated && deliveryFailed) {
    return {
      text: 'Your feedback was saved (trimmed a bit), but we could not notify the team - please ping support if it is urgent.',
      level: 'warning',
    };
  }
  if (result.contentTruncated) {
    return { text: 'Your feedback was saved, but it was long enough that we had to trim it a bit.', level: 'warning' };
  }
  if (deliveryFailed) {
    return {
      text: 'Saved your feedback, but we could not notify the team - please ping support if it is urgent.',
      level: 'warning',
    };
  }
  return { text: 'Thank you! Your feedback has been sent to the team.', level: 'success' };
}

/**
 * `/feedback <text>` - feedback about the conversation as a whole rather than one answer.
 * The subject is the session; the newest quest rides along as `contextQuestId` so a reader knows
 * where the user was when they wrote it. Both are claims only - the server re-reads and
 * ownership-checks them (see feedbackContext.ts) before either reaches the saved record.
 */
export async function handleFeedbackCommand(args: FeedbackCommandArgs) {
  const { params, userId, username, userEmail, currentSession, queryClient, addMessageToSession } = args;

  const reply = async (text: string) => {
    if (!addMessageToSession || !currentSession) return;
    await addMessageToSession({
      sessionId: currentSession.id,
      timestamp: new Date(),
      type: 'system',
      prompt: '/feedback',
      reply: text,
      oob: '',
    });
  };

  const content = params.trim();
  if (!content) {
    toast.info(FEEDBACK_COMMAND_USAGE);
    await reply(FEEDBACK_COMMAND_USAGE);
    return;
  }

  try {
    const result = await createFeedbackOnServer({
      userId,
      username: username ?? 'Unknown',
      userEmail: userEmail ?? 'Unknown',
      tags: ['feedback', 'slash-command'],
      type: FeedbackType.FEEDBACK,
      status: FeedbackStatus.New,
      content,
      ...(currentSession
        ? {
            sessionId: currentSession.id,
            contextQuestId: findLatestQuestId(queryClient, currentSession.id),
          }
        : {}),
    });

    const { text, level } = outcomeMessage(result);
    toast[level](text);
    await reply(text);
  } catch (error) {
    console.error('Failed to submit /feedback:', error);
    toast.error('Could not submit your feedback. Please try again.');
    await reply('Could not submit your feedback. Please try again.');
  }
}
