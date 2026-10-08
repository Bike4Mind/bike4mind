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

  /**
   * `onFailed` runs when the browser will not leave for GitHub: with the start's error when it was refused,
   * or with nothing when the handoff could not be saved. `ensureConnectorFed` has the start switch a
   * curated lake first, server-side and only if the start is accepted (see the start route).
   *
   * Awaits `mutateAsync` rather than passing per-call `mutate` callbacks: react-query drops those once
   * the calling component unmounts, so closing the connect modal mid-request would strand the flow.
   */
  const begin = async ({
    onFailed,
    ensureConnectorFed,
  }: { onFailed?: (error?: unknown) => void; ensureConnectorFed?: boolean } = {}) => {
    let authorizeUrl: string;
    try {
      ({ authorizeUrl } = await start.mutateAsync({ dataLakeId, ensureConnectorFed }));
    } catch (e: unknown) {
      // e.g. "already connected to a Google Drive folder", or "is curated": the picker's Reconnect
      // does not ask to switch origin, and it can change mid-flow.
      toast.error(getServerErrorField(e) || 'Could not start the GitHub connection. Please try again.');
      onFailed?.(e);
      return;
    }
    try {
      saveGitHubLakeConnectHandoff({ dataLakeId });
    } catch {
      // Without the handoff the callback page has nowhere to land once GitHub returns.
      toast.error('Could not start the GitHub connection: this browser blocked session storage.');
      onFailed?.();
      return;
    }
    window.location.assign(authorizeUrl);
  };

  return { begin, isPending: start.isPending };
}
