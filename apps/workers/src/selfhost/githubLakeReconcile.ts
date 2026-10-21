import { runGitHubLakeReconcile } from '@workers/cron/githubLakeReconcile';
import type { SelfHostWorker } from './selfHostWorker';

/** Matches the hosted githubLakeReconcile cron's rate(15 minutes) in infra/cron.ts. */
export const GITHUB_LAKE_RECONCILE_INTERVAL_MS = 15 * 60_000;

export function registerGitHubLakeReconcile(worker: SelfHostWorker): void {
  worker.registerScheduledTask('githubLakeReconcile', GITHUB_LAKE_RECONCILE_INTERVAL_MS, async () => {
    await runGitHubLakeReconcile();
  });
}
