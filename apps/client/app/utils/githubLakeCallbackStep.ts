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
  /** Install returned no `code` (the App was already on that account): fetch one via authorize. */
  | { kind: 'authorize'; authorizeUrl: string; handoff: GitHubLakeConnectHandoff }
  | { kind: 'complete'; dataLakeId: string; state: string; code: string; installationId: number };

const RESTART_MESSAGE = 'The GitHub connection could not be completed. Start it again from the data lake.';
const APPROVAL_PENDING_MESSAGE =
  'GitHub sent the install to an owner of that organization for approval. Connect the repository again once they approve it.';

function parseInstallationId(raw: string | undefined): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * What the callback page does with one GitHub return. Two shapes arrive here:
 * - from the install: `installation_id` + `state`, plus `code` only on a first install;
 * - from the authorize bounce: `code` + `state` only, the installation id held in the handoff.
 */
export function resolveGitHubLakeCallbackStep(
  search: GitHubLakeCallbackSearch,
  handoff: GitHubLakeConnectHandoff | null
): GitHubLakeCallbackStep {
  if (search.error === 'access_denied') return { kind: 'cancelled' };
  // A GitHub org member who is not an owner can only request the install, so nothing is installed yet.
  if (search.setup_action === 'request') return { kind: 'failed', message: APPROVAL_PENDING_MESSAGE };
  if (search.error || !search.state || !handoff) return { kind: 'failed', message: RESTART_MESSAGE };

  const installationId = parseInstallationId(search.installation_id) ?? handoff.installationId;
  if (!installationId) return { kind: 'failed', message: RESTART_MESSAGE };

  if (!search.code) {
    // Only the install return may bounce, and only once: an authorize return without a code is a failure.
    if (handoff.installationId !== undefined) return { kind: 'failed', message: RESTART_MESSAGE };
    return { kind: 'authorize', authorizeUrl: handoff.authorizeUrl, handoff: { ...handoff, installationId } };
  }

  return {
    kind: 'complete',
    dataLakeId: handoff.dataLakeId,
    state: search.state,
    code: search.code,
    installationId,
  };
}
