import { LinearProgress } from '@mui/joy';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useAuthorizeLakeGitHubConnect } from '@client/app/hooks/data/githubLake';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import {
  clearGitHubLakeConnectHandoff,
  readGitHubLakeConnectHandoff,
} from '@client/app/utils/githubLakeConnectHandoff';
import { applyRedirect } from '@client/app/utils/authRedirect';
import { getServerErrorField } from '@client/app/utils/error';
import { getGitHubLakeCallbackBootSearch } from '@client/app/utils/githubLakeCallbackSearch';
import { resolveGitHubLakeCallbackStep, type GitHubLakeCallbackSearch } from '@client/app/utils/githubLakeCallbackStep';

/**
 * Where the data-lake GitHub App returns the browser, from its install page and from its OAuth
 * authorize page. An authorize return exchanges its code for the lake id, then opens the repository
 * picker (GitHubRepositoryPickerModal, mounted in the data-lake manager); every other return just
 * reopens the picker or reports why the flow could not continue. Renders no UI of its own.
 */
const GitHubLakeCallbackPage = () => {
  const router = useRouter();
  const openManager = useDataLakeWizardStore(s => s.openManager);
  const openGitHubRepoPicker = useDataLakeWizardStore(s => s.openGitHubRepoPicker);
  const setGitHubConnectFailure = useDataLakeWizardStore(s => s.setGitHubConnectFailure);
  const authorize = useAuthorizeLakeGitHubConnect();
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

    const land = (dataLakeId: string | undefined, openPicker: boolean) => {
      clearGitHubLakeConnectHandoff();
      // replace: Back must not return to this single-use callback URL.
      applyRedirect(router.history, handoff?.returnPath, '/', true);
      if (!dataLakeId) return;
      openManager('mine', dataLakeId);
      if (openPicker) openGitHubRepoPicker(dataLakeId);
    };

    // With a lake to land on, the reason goes on that lake's finish-connect banner next to a Try again;
    // without one there is nowhere to show it but a toast.
    const landFailed = (dataLakeId: string | undefined, message: string) => {
      if (dataLakeId) setGitHubConnectFailure({ lakeId: dataLakeId, message });
      else toast.error(message);
      land(dataLakeId, false);
    };

    switch (step.kind) {
      case 'cancelled':
        landFailed(handoff?.dataLakeId, 'GitHub connection cancelled.');
        return;
      case 'failed':
        landFailed(handoff?.dataLakeId, step.message);
        return;
      case 'repaired':
        toast.info('GitHub access updated. Use Re-sync on the lake to resume syncing.');
        land(undefined, false);
        return;
      case 'resume':
        if (step.notice) toast.info(step.notice);
        land(step.dataLakeId, true);
        return;
      case 'authorize':
        authorize.mutate(
          { state: step.state, code: step.code },
          {
            onSuccess: ({ dataLakeId }) => land(dataLakeId, true),
            // The server's reason is the actionable part: an expired/mismatched state, a lake that
            // can no longer take a connection.
            onError: (e: unknown) => landFailed(step.dataLakeId, getServerErrorField(e) || 'Could not connect GitHub.'),
          }
        );
        return;
    }
  }, [router, openManager, openGitHubRepoPicker, setGitHubConnectFailure, authorize]);

  return <LinearProgress data-testid="github-lake-callback-progress" />;
};

export default GitHubLakeCallbackPage;
