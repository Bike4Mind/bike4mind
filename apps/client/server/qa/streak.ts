import type { QaRunStatus } from '@bike4mind/common';

/** One alarm/tile state: runs with the same key are compared against each other. */
export interface QaStateKey {
  product: string;
  tenant?: string;
  suite: string;
  env: string;
  branch: string;
}

export function stateKeyFilter(key: QaStateKey): Record<string, unknown> {
  return {
    product: key.product,
    suite: key.suite,
    env: key.env,
    branch: key.branch,
    // ingestRun drops an undefined tenant, so "no tenant" is a missing field.
    tenant: key.tenant ?? { $exists: false },
  };
}

export function leadingNonPassing(runsNewestFirst: readonly { status: QaRunStatus; startedAt: Date }[]): {
  count: number;
  since?: Date;
} {
  let count = 0;
  let since: Date | undefined;
  for (const run of runsNewestFirst) {
    if (run.status === 'passed') break;
    count += 1;
    since = run.startedAt;
  }
  return since ? { count, since } : { count };
}
