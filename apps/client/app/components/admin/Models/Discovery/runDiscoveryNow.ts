import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { toast } from 'sonner';
import { MODEL_LIST_REVISION_MEMO_MS } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { ADMIN_MODELS_QUERY_KEY } from '@client/app/hooks/data/adminModels';
import { MODEL_CATALOG_QUERY_KEY } from '@client/app/hooks/data/useModelInfo';
import {
  DISCOVERY_STATUS_PATH,
  DISCOVERY_STATUS_QUERY_KEY,
  LIFECYCLE_QUEUE_QUERY_KEY,
  apiCodeOf,
  apiErrorMessage,
  apiServerMessage,
  apiStatusOf,
  fetchDiscoveryStatus,
  type DiscoveryLastRun,
  type DiscoveryStatus,
} from './discoveryApi';
import { DISCOVERY_OFF_DESCRIPTION, DISCOVERY_OFF_TITLE, LISTING_IN_PROGRESS, runResult } from './discoveryCopy';
import { useModelsNavigation } from '../modelsNavigation';

export const POLL_INTERVAL_MS = 5_000;
/** Long enough for a full fan-out over every provider; past it, say so and stop. */
export const POLL_TIMEOUT_MS = 120_000;
/** A flaky status read must not end a wait the run itself is still honouring. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

type Phase = 'idle' | 'dispatching' | 'waiting';

/**
 * One Run now per tab, shared by the header's Run discovery and the Discovery section's Run now, so a click on
 * either disables both and a second poll loop can never race the first.
 */
export const useRunNowStore = create<{
  phase: Phase;
  notice: string | null;
  error: string | null;
  /** Bumped when a run this tab awaited finishes; views outside react-query (the price catalog) refetch on it. */
  finishedRuns: number;
}>(() => ({
  phase: 'idle',
  notice: null,
  error: null,
  finishedRuns: 0,
}));

export type RunNowOutcome =
  | { kind: 'finished'; run: DiscoveryLastRun }
  | { kind: 'failed'; message: string; discoveryOff: boolean }
  | { kind: 'gave-up'; message: string }
  | { kind: 'busy' }
  | { kind: 'abandoned' };

// Mounted users of the hook. Leaving the Models page unmounts them all, which ends the wait.
let subscribers = 0;
let wake: (() => void) | null = null;

const sleep = (ms: number) =>
  new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

const set = (patch: Partial<ReturnType<typeof useRunNowStore.getState>>) => useRunNowStore.setState(patch);

/**
 * Is this the run the button asked for? A cron run can land mid-wait, so newer than the baseline is not enough:
 * only a manual trigger is ours.
 */
const isAwaitedRun = (run: DiscoveryLastRun | null, baselineMs: number) => {
  if (!run || new Date(run.startedAt).getTime() <= baselineMs) return false;
  return run.trigger ? run.trigger === 'manual' : true;
};

const giveUpMessage = (sawNewRun: boolean, enabled: boolean) => {
  if (sawNewRun) return 'The run is still going. This page stopped waiting for it; it shows in the run list when done.';
  if (!enabled) return `No new run reported within 2 minutes. ${DISCOVERY_OFF_TITLE}.`;
  return 'No new run reported within 2 minutes. Another run may already be in progress.';
};

const dispatchFailure = (error: unknown): { message: string; discoveryOff: boolean } => {
  const status = apiStatusOf(error);
  if (status === 409 && apiCodeOf(error) === 'discovery-disabled') {
    return { message: `${DISCOVERY_OFF_TITLE}. ${DISCOVERY_OFF_DESCRIPTION}`, discoveryOff: true };
  }
  if (status === 409) return { message: apiServerMessage(error) ?? LISTING_IN_PROGRESS, discoveryOff: false };
  if (status === 503) {
    return { message: `Run now is not available here. ${apiServerMessage(error) ?? ''}`.trim(), discoveryOff: false };
  }
  return { message: apiErrorMessage(error, 'Run now failed'), discoveryOff: false };
};

/** Refreshes what a finished run can change: this console's lists and, past the server memo, open pickers. */
const refreshAfterRun = (queryClient: QueryClient) => {
  useRunNowStore.setState(state => ({ finishedRuns: state.finishedRuns + 1 }));
  void queryClient.invalidateQueries({ queryKey: ADMIN_MODELS_QUERY_KEY });
  void queryClient.invalidateQueries({ queryKey: LIFECYCLE_QUEUE_QUERY_KEY });
  // Not before every server process has dropped the list it built under the previous revision.
  setTimeout(
    () => void queryClient.invalidateQueries({ queryKey: MODEL_CATALOG_QUERY_KEY }),
    MODEL_LIST_REVISION_MEMO_MS
  );
};

async function awaitRun(queryClient: QueryClient, baseline: DiscoveryStatus): Promise<RunNowOutcome> {
  const baselineMs = baseline.lastRun ? new Date(baseline.lastRun.startedAt).getTime() : 0;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let latest = baseline;
  let consecutiveFailures = 0;
  let sawNewRun = false;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (subscribers === 0) return { kind: 'abandoned' };
    try {
      latest = await fetchDiscoveryStatus();
      consecutiveFailures = 0;
      queryClient.setQueryData(DISCOVERY_STATUS_QUERY_KEY, latest);
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        const message = apiErrorMessage(error, 'Lost track of the run');
        set({ error: message, notice: null });
        return { kind: 'gave-up', message };
      }
      continue;
    }
    if (!isAwaitedRun(latest.lastRun, baselineMs)) continue;
    sawNewRun = true;
    if (latest.lastRun?.finishedAt) {
      refreshAfterRun(queryClient);
      set({ notice: null });
      return { kind: 'finished', run: latest.lastRun };
    }
  }
  const message = giveUpMessage(sawNewRun, latest.enabled !== false);
  set({ notice: message });
  return { kind: 'gave-up', message };
}

/**
 * Dispatches a run and waits for it to report. The run happens on the cron lambda (hosted) or in the server
 * process (self-host), so the outcome comes back by polling for a manual run newer than the one on record when
 * the button was clicked.
 */
export async function startDiscoveryRun(queryClient: QueryClient): Promise<RunNowOutcome> {
  if (useRunNowStore.getState().phase !== 'idle') return { kind: 'busy' };
  set({ phase: 'dispatching', notice: null, error: null });
  try {
    let baseline: DiscoveryStatus;
    try {
      // Re-read right before dispatching: a cron run that landed while the tab sat open would otherwise be read as
      // the answer to this click.
      baseline = await fetchDiscoveryStatus();
      queryClient.setQueryData(DISCOVERY_STATUS_QUERY_KEY, baseline);
      await api.post(DISCOVERY_STATUS_PATH);
    } catch (error) {
      const failure = dispatchFailure(error);
      set({ error: failure.message });
      return { kind: 'failed', ...failure };
    }
    set({ phase: 'waiting', notice: 'Run started. Waiting for it to report.' });
    return await awaitRun(queryClient, baseline);
  } finally {
    set({ phase: 'idle' });
  }
}

/** The shared Run now. `onFinished` runs only while the caller is mounted; otherwise a toast links to the run. */
export function useRunDiscoveryNow() {
  const queryClient = useQueryClient();
  const { openRun } = useModelsNavigation();
  const phase = useRunNowStore(state => state.phase);
  const notice = useRunNowStore(state => state.notice);
  const error = useRunNowStore(state => state.error);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    subscribers += 1;
    return () => {
      mounted.current = false;
      subscribers -= 1;
      if (subscribers === 0) wake?.();
    };
  }, []);

  const announceFinished = useCallback(
    (run: DiscoveryLastRun) =>
      toast.success(`Discovery run finished: ${runResult(run).label}.`, {
        action: { label: 'View run', onClick: () => void openRun(run.id) },
      }),
    [openRun]
  );

  const runNow = useCallback(
    async (onFinished?: (run: DiscoveryLastRun) => void): Promise<RunNowOutcome> => {
      const outcome = await startDiscoveryRun(queryClient);
      if (outcome.kind === 'finished') {
        if (mounted.current && onFinished) onFinished(outcome.run);
        else announceFinished(outcome.run);
      }
      return outcome;
    },
    [queryClient, announceFinished]
  );

  return { runNow, announceFinished, phase, busy: phase !== 'idle', notice, error };
}
