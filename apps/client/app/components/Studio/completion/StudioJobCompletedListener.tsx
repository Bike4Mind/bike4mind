import { useEffect } from 'react';
import { toast } from 'sonner';
import type { StudioJobCompletion } from '@bike4mind/common';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useStudioFeature } from '@client/app/components/Studio/useStudioFeature';
import { router } from '@client/app/router';
import { describeStudioCompletion } from './studioCompletionToast';

const TOAST_DURATION_MS = 10_000;

const TOAST_BY_TONE = { success: toast.success, warning: toast.warning, error: toast.error } as const;

export const showStudioCompletionToast = (
  completion: StudioJobCompletion,
  open: (link: string) => void = link => router.history.push(link)
): void => {
  const { tone, message, description } = describeStudioCompletion(completion);
  TOAST_BY_TONE[tone](message, {
    // Keyed by group: a redelivered event, or a second socket in this tab, replaces rather than stacks.
    id: `studio-completion-${completion.groupId}`,
    description,
    duration: TOAST_DURATION_MS,
    action: { label: 'Open', onClick: () => open(completion.link) },
  });
};

/**
 * Shows a toast when a Studio group finishes (studio_job_completed frames), wherever the user is in the app.
 * Behind EnableStudioImage. Mounted once inside UserProvider (app/providers.tsx), since the flag reads the user.
 */
const StudioJobCompletedListener = () => {
  const { subscribeToAction } = useWebsocket();
  const enabled = useStudioFeature('image');

  useEffect(() => {
    if (!enabled) return;
    return subscribeToAction('studio_job_completed', async message => {
      if (message.action !== 'studio_job_completed') return;
      showStudioCompletionToast(message.completion);
    });
  }, [enabled, subscribeToAction]);

  return null;
};

export default StudioJobCompletedListener;
