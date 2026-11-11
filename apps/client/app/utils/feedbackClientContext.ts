import { sanitizeFeedbackPagePath } from '@bike4mind/common';
import type { FeedbackClientContextInput } from '@bike4mind/common';
import type { QueryClient } from '@tanstack/react-query';
import { useLLM } from '@client/app/contexts/LLMContext';

/**
 * What every report producer sends as `clientContext`, built in one place so the producers cannot
 * drift. The version comes from the `useAppVersion` cache rather than a fetch: a producer must not
 * wait on the network to file a report. So it is the latest `/version.json`, not the bundle the tab
 * is running (a tab left open across a deploy reports the new version), and an empty cache omits
 * the field. The server re-validates and adds the user agent itself.
 */
export function buildFeedbackClientContext(queryClient: QueryClient): FeedbackClientContextInput {
  const version = queryClient.getQueryData<{ version?: unknown }>(['appVersion'])?.version;
  const model = useLLM.getState().model;
  const hasWindow = typeof window !== 'undefined';

  return {
    platform: 'web',
    ...(hasWindow
      ? {
          path: sanitizeFeedbackPagePath(window.location.pathname),
          viewport: { width: Math.round(window.innerWidth), height: Math.round(window.innerHeight) },
        }
      : {}),
    ...(typeof version === 'string' && version ? { appVersion: version } : {}),
    ...(model ? { model } : {}),
  };
}
