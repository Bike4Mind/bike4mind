import { toast } from 'sonner';
import { useStartLakeGitHubConnect } from '@client/app/hooks/data/githubLake';
import { getServerErrorField } from '@client/app/utils/error';
import { saveGitHubLakeConnectHandoff } from '@client/app/utils/githubLakeConnectHandoff';

/**
 * Starts (or restarts) a lake's GitHub connect: mints the authorize URL, saves the handoff so the
 * callback page can find its way back to this lake, then leaves for GitHub's OAuth page. Shared by
 * GitHubConnectAction (first connect) and the repository picker's "Reconnect GitHub" (the flow's
 * held token expired) - both need exactly the same handoff-then-redirect sequence.
 */
export function useBeginLakeGitHubConnect(dataLakeId: string) {
  const start = useStartLakeGitHubConnect();

  const begin = () =>
    start.mutate(dataLakeId, {
      onSuccess: ({ authorizeUrl }) => {
        try {
          saveGitHubLakeConnectHandoff({ dataLakeId });
        } catch {
          // Without the handoff the callback page has nowhere to land once GitHub returns.
          toast.error('Could not start the GitHub connection: this browser blocked session storage.');
          return;
        }
        window.location.assign(authorizeUrl);
      },
      // e.g. "is curated, change its origin", "already connected to a Google Drive folder".
      onError: (e: unknown) =>
        toast.error(getServerErrorField(e) || 'Could not start the GitHub connection. Please try again.'),
    });

  return { begin, isPending: start.isPending };
}
