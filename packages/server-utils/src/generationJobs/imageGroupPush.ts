import { studioCompletionLink, type PushNotificationEvent } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import type { GroupCompletion, GroupCompletionSubscriber } from '@bike4mind/services/generationJobs';
import {
  type ConnectionLookup,
  hasLiveConnection,
  isPushDeliveryConfigured,
  truncateForPush,
} from '../utils/pushNotifications';

export type ImageGroupPushDeps = {
  connections: ConnectionLookup;
  appPathDeepLink(path: string): string;
  appRootDeepLink(): string;
  publish(event: PushNotificationEvent): Promise<void>;
  logger: Pick<Logger, 'warn'>;
};

const PUSH_BODY_MAX_CHARS = 160;

// Takes the user cancelled are left out of the count: they were not asked for any more.
const titleOf = ({ readyCount, members, cancelledCount }: GroupCompletion): string => {
  const wanted = members.length - cancelledCount;
  if (wanted === 1) return 'Image ready';
  if (readyCount === wanted) return `${readyCount} images ready`;
  return `${readyCount} of ${wanted} images ready`;
};

const bodyOf = ({ anchor, readyCount }: GroupCompletion): string => {
  const prompt = anchor.payload.request.prompt?.replace(/\s+/g, ' ').trim();
  if (prompt) return truncateForPush(prompt, PUSH_BODY_MAX_CHARS);
  return readyCount > 1 ? 'Your images are ready.' : 'Your image is ready.';
};

/**
 * One `generation_ready` push per finished image batch ("make N" pushes once, not N times), from the group completion
 * decision. Image jobs take the chat image rule: no push while the user has a live browser connection, where the
 * Studio toast or the chat already shows the result. A batch with nothing to show is not pushed (there is no failure
 * category), and neither is one requested from Slack, which reports back in its own thread.
 */
export const imageGroupPushSubscriber = (deps: ImageGroupPushDeps): GroupCompletionSubscriber => ({
  name: 'push',
  wants: job => job.kind === 'image' && !job.delivery,
  deliver: async completion => {
    if (!isPushDeliveryConfigured() || completion.readyCount === 0) return;
    const { anchor, groupId } = completion;
    if (await hasLiveConnection(anchor.requestedBy, deps.connections, deps.logger)) return;
    await deps.publish({
      userId: anchor.requestedBy,
      category: 'generation_ready',
      title: titleOf(completion),
      body: bodyOf(completion),
      deepLink:
        anchor.source === 'studio'
          ? deps.appPathDeepLink(studioCompletionLink('image', groupId))
          : deps.appRootDeepLink(),
      collapseId: `generation:${groupId}`,
      ...(anchor.questId && { questId: anchor.questId }),
    });
  },
});
