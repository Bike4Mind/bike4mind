import type { GroupCompletionCallback, JobStatusCallback } from '../agents/BackgroundAgentManager.js';
import { useCliStore } from '../store/index.js';

/**
 * Background-agent callbacks for one session. Once `isCurrent` turns false (the session was released for a
 * sign-in), they do nothing, so the released session's agents never queue a turn in the session that replaced it.
 */
export function sessionBackgroundCallbacks(isCurrent: () => boolean): {
  onBackgroundStatusChange: JobStatusCallback;
  onGroupCompletion: GroupCompletionCallback;
} {
  return {
    onBackgroundStatusChange: job => {
      if (isCurrent()) useCliStore.getState().upsertBackgroundAgent(job);
    },
    onGroupCompletion: (notification, groupDescription) => {
      if (!isCurrent()) return;
      const store = useCliStore.getState();
      store.addCompletedGroupNotification(notification, groupDescription);
      // The turn starts once nothing else is thinking (see App).
      store.setPendingBackgroundTrigger(true);
    },
  };
}

/** Drops background results a released session left waiting, so the next session does not act on them. */
export function forgetBackgroundCompletions(): void {
  const store = useCliStore.getState();
  store.setPendingBackgroundTrigger(false);
  store.clearCompletedGroupNotifications();
}
