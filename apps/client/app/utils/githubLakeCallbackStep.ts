import type { GitHubLakeConnectHandoff } from './githubLakeConnectHandoff';

/** Query params GitHub sends back from the App install page or from its OAuth authorize page. */
export type GitHubLakeCallbackSearch = {
  installation_id?: string;
  code?: string;
  state?: string;
  error?: string;
  setup_action?: string;
};

export type GitHubLakeCallbackStep =
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string }
  /** The authorize return: exchange `code` for the lake id, then open its repository picker. */
  | { kind: 'authorize'; dataLakeId: string; state: string; code: string }
  /**
   * Reopen the picker without a server round-trip: the server already holds this flow's GitHub
   * token from the first authorize. Reached from the install fallback's return (no `code`) and from
   * an org-owner approval request, which carries a one-time notice for the toast.
   */
  | { kind: 'resume'; dataLakeId: string; notice?: string };

export const RESTART_MESSAGE = 'The GitHub connection could not be completed. Start it again from the data lake.';
const APPROVAL_PENDING_NOTICE =
  'GitHub sent the install request to an organization owner. Once they approve it, refresh the repository list.';

/**
 * What the callback page does with one GitHub return. Three shapes arrive here:
 * - the authorize return, or an install return that carried user authorization: `code` + `state`,
 *   exchanged server-side for the flow's user token;
 * - an install return without a `code` (`installation_id` and/or `setup_action`): the server still
 *   holds the flow's token, so the picker just reopens;
 * - a non-owner's install request: `setup_action=request`, nothing installed yet.
 */
export function resolveGitHubLakeCallbackStep(
  search: GitHubLakeCallbackSearch,
  handoff: GitHubLakeConnectHandoff | null
): GitHubLakeCallbackStep {
  if (search.error === 'access_denied') return { kind: 'cancelled' };
  if (!handoff) return { kind: 'failed', message: RESTART_MESSAGE };
  if (search.error) return { kind: 'failed', message: RESTART_MESSAGE };

  if (search.code && search.state) {
    return { kind: 'authorize', dataLakeId: handoff.dataLakeId, state: search.state, code: search.code };
  }

  // A GitHub org member who is not an owner can only request the install, so nothing is installed yet.
  if (search.setup_action === 'request') {
    return { kind: 'resume', dataLakeId: handoff.dataLakeId, notice: APPROVAL_PENDING_NOTICE };
  }

  if (!search.code && (search.installation_id || search.setup_action)) {
    return { kind: 'resume', dataLakeId: handoff.dataLakeId };
  }

  return { kind: 'failed', message: RESTART_MESSAGE };
}
