import { LinearProgress } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useCompleteLakeGitHubConnect } from '@client/app/hooks/data/githubLake';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import {
  clearGitHubLakeConnectHandoff,
  readGitHubLakeConnectHandoff,
  saveGitHubLakeConnectHandoff,
} from '@client/app/utils/githubLakeConnectHandoff';
import { getServerErrorField } from '@client/app/utils/error';
import { getGitHubLakeCallbackBootSearch } from '@client/app/utils/githubLakeCallbackSearch';
import { resolveGitHubLakeCallbackStep, type GitHubLakeCallbackSearch } from '@client/app/utils/githubLakeCallbackStep';

/**
 * Where the data-lake GitHub App returns the browser, from its install page and from its OAuth
 * authorize page. Finishes the connect started by GitHubConnectAction, then lands on the lake in
 * the manager. Renders no UI of its own.
 */
const GitHubLakeCallbackPage = () => {
  const navigate = useNavigate();
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const complete = useCompleteLakeGitHubConnect();
  // GitHub's `code` is single-use, so a second run (StrictMode, a re-render) must never re-post it.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    // By now the router has rewritten the URL (quoted the numeric installation_id, parsed an all-digit
    // code), so read the query GitHub actually sent, snapshotted before the router started.
    const raw = new URLSearchParams(getGitHubLakeCallbackBootSearch() ?? window.location.search);
    const search: GitHubLakeCallbackSearch = {
      installation_id: raw.get('installation_id') ?? undefined,
      code: raw.get('code') ?? undefined,
      state: raw.get('state') ?? undefined,
      error: raw.get('error') ?? undefined,
      setup_action: raw.get('setup_action') ?? undefined,
    };
    const handoff = readGitHubLakeConnectHandoff();
    const step = resolveGitHubLakeCallbackStep(search, handoff);

    const finish = (dataLakeId?: string) => {
      clearGitHubLakeConnectHandoff();
      navigate({ to: '/' });
      if (dataLakeId) openManager('mine', dataLakeId);
    };

    switch (step.kind) {
      case 'cancelled':
        toast.error('GitHub connection cancelled.');
        finish(handoff?.dataLakeId);
        return;
      case 'failed':
        toast.error(step.message);
        finish(handoff?.dataLakeId);
        return;
      case 'authorize':
        try {
          saveGitHubLakeConnectHandoff(step.handoff);
        } catch {
          // The authorize return would arrive without its installation id and could only fail.
          toast.error('Could not continue the GitHub connection: this browser blocked session storage.');
          finish(step.handoff.dataLakeId);
          return;
        }
        window.location.assign(step.authorizeUrl);
        return;
      case 'complete':
        complete.mutate(
          { state: step.state, code: step.code, installationId: step.installationId },
          {
            onSuccess: connection =>
              toast.success(`Connected ${connection.repositoryFullName}. Its first sync is queued.`),
            // The server's reason is the actionable part: install policy, no unbound repository, expired state.
            onError: (e: unknown) => toast.error(getServerErrorField(e) || 'Could not connect the GitHub repository.'),
            onSettled: () => finish(step.dataLakeId),
          }
        );
        return;
    }
  }, [navigate, openManager, complete]);

  return <LinearProgress data-testid="github-lake-callback-progress" />;
};

export default GitHubLakeCallbackPage;
