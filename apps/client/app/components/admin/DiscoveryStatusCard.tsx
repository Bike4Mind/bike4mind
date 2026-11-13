import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, CircularProgress, Link, Stack, Tooltip, Typography } from '@mui/joy';
import { MODEL_LIST_REVISION_MEMO_MS, type IDiscoverySkippedSource } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { api } from '@client/app/contexts/ApiContext';
import { MODEL_CATALOG_QUERY_KEY } from '@client/app/hooks/data/useModelInfo';
import { DiscoveryRunDetailModal } from './DiscoveryRunDetailModal';
import { ErrorState, LoadingState, SectionCard, StatusChip } from './shared';

/** Wire shapes of /api/admin/model-discovery (dates arrive as strings). */
interface DiscoverySource {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

interface DiscoveryJoinCoverage {
  aggregator: string;
  matched: number;
  total: number;
}

interface DiscoveryChangeCounts {
  added: number;
  promoted: number;
  deprecated: number;
  repriced: number;
  flagged: number;
}

/** A run on the history list: counts only, since this response is polled. */
interface DiscoveryRunListItem {
  id: string;
  startedAt: string;
  finishedAt?: string | null;
  trigger: string;
  host: string;
  status: 'ok' | 'partial' | 'failed';
  changes: DiscoveryChangeCounts;
}

interface DiscoveryRunSummary extends DiscoveryRunListItem {
  sources: DiscoverySource[];
  /**
   * Configured sources the run never attempted. The route always sends an array,
   * so an absent one only reaches here from a payload cached before the field.
   */
  skippedSources?: IDiscoverySkippedSource[];
  joinCoverage: DiscoveryJoinCoverage[];
}

interface DiscoveryStatus {
  lastRun: DiscoveryRunSummary | null;
  /** Newest first; runs[0] is the same run as lastRun. */
  runs: DiscoveryRunListItem[];
  lastSuccessfulRunAt: string | null;
  enabled: boolean;
  mode: string;
  autoEnable: string;
  selfHost: boolean;
}

const POLL_INTERVAL_MS = 5_000;
/** Long enough for a full fan-out over every provider; past it, say so and stop. */
const POLL_TIMEOUT_MS = 120_000;
/** A flaky status read must not end a wait the run itself is still honouring. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

const DISABLED_HINT = 'Model discovery is turned off (enableModelDiscovery), so no run will start.';
const LOAD_FAILED = 'Failed to load discovery status';

const STATUS_TONE: Record<DiscoveryRunSummary['status'], AdminStatusTone> = {
  ok: 'good',
  partial: 'warn',
  failed: 'bad',
};

const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const formatTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');

/** Matches the run document's TTL in packages/database ModelDiscoveryRunModel. */
const RUN_RETENTION_NOTE = 'Runs are kept for 90 days.';

const changeSummary = (changes: DiscoveryChangeCounts) => {
  const parts = Object.entries(changes)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`);
  return parts.length > 0 ? parts.join(', ') : 'no catalog changes';
};

/**
 * Is this the run the button just asked for? A cron run can land mid-wait, so
 * newer-than-baseline alone is not enough - only a manual trigger is ours.
 */
const isAwaitedRun = (run: DiscoveryRunSummary | null, baselineMs: number) => {
  if (!run || new Date(run.startedAt).getTime() <= baselineMs) return false;
  return run.trigger ? run.trigger === 'manual' : true;
};

const giveUpMessage = (sawNewRun: boolean, enabled: boolean) => {
  if (sawNewRun) return 'The run is still going; this card has stopped waiting on it.';
  if (!enabled) return `No new run reported within 2 minutes - ${DISABLED_HINT}`;
  return 'No new run reported within 2 minutes - another run may already hold the lease.';
};

/**
 * Discovery status and its "Run now" (spec sec 7): what the last run did, what
 * the next one is allowed to do, and a button to start one.
 *
 * "Run now" only dispatches - the run happens on the cron lambda (hosted) or in
 * the long-lived server process (self-host), so the outcome comes back by
 * polling for a run document newer than the one on screen when the button was
 * clicked. A run that never appears is usually the lease: a run already in
 * flight makes the manual trigger a deliberate no-op.
 *
 * The change counts and the run history are entry points into
 * DiscoveryRunDetailModal: the counts alone ("34 flagged") name no model and no
 * reason, and the 6h cron would otherwise erase whatever run was being read.
 *
 * Chips carry only short statuses and wrap as whole pills; the long lists (skipped sources,
 * coverage) are plain text so they wrap instead of truncating at narrow widths.
 */
export const DiscoveryStatusCard: React.FC<{ onRunFinished?: () => void }> = ({ onRunFinished }) => {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [showFailures, setShowFailures] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  // The run being read, captured by id: a poll refreshes `status` underneath it
  // and must never swap out the report the operator has open.
  const [detailRunId, setDetailRunId] = useState<string | null>(null);

  // The poll loop outlives a fast unmount (2 minutes of it), so every state
  // write past an await is gated on this.
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const load = useCallback(async (): Promise<DiscoveryStatus> => {
    const res = await api.get<DiscoveryStatus>('/api/admin/model-discovery');
    if (!unmounted.current) setStatus(res.data);
    return res.data;
  }, []);

  useEffect(() => {
    void load().catch(err => setError(apiErrorMessage(err, LOAD_FAILED)));
  }, [load]);

  const retryLoad = () => {
    setError(null);
    void load().catch(err => setError(apiErrorMessage(err, LOAD_FAILED)));
  };

  const awaitRun = useCallback(
    async (baselineStatus: DiscoveryStatus) => {
      const baselineMs = baselineStatus.lastRun ? new Date(baselineStatus.lastRun.startedAt).getTime() : 0;
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let latest = baselineStatus;
      let consecutiveFailures = 0;
      let sawNewRun = false;
      setIsWaiting(true);
      try {
        while (Date.now() < deadline && !unmounted.current) {
          await sleep(POLL_INTERVAL_MS);
          if (unmounted.current) return;
          try {
            latest = await load();
            consecutiveFailures = 0;
          } catch (err) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
              if (!unmounted.current) setError(apiErrorMessage(err, 'Lost track of the run'));
              return;
            }
            continue;
          }
          if (!isAwaitedRun(latest.lastRun, baselineMs)) continue;
          sawNewRun = true;
          if (latest.lastRun?.finishedAt) {
            // Not before every server process has dropped the list it built under the previous revision.
            setTimeout(
              () => void queryClient.invalidateQueries({ queryKey: MODEL_CATALOG_QUERY_KEY }),
              MODEL_LIST_REVISION_MEMO_MS
            );
            if (!unmounted.current) {
              setNotice(`Run finished: ${latest.lastRun.status}.`);
              onRunFinished?.();
            }
            return;
          }
        }
        if (!unmounted.current) setNotice(giveUpMessage(sawNewRun, latest.enabled !== false));
      } finally {
        if (!unmounted.current) setIsWaiting(false);
      }
    },
    [load, queryClient, onRunFinished]
  );

  const runNow = async () => {
    setIsDispatching(true);
    setError(null);
    setNotice(null);
    try {
      // Re-read the baseline immediately before dispatching: a cron run that landed
      // while this tab sat open would otherwise be read as the answer to this click.
      const baselineStatus = await load();
      const res = await api.post<{ dispatched: string }>('/api/admin/model-discovery');
      setNotice(`Dispatched (${res.data.dispatched}); waiting for the run to report.`);
      void awaitRun(baselineStatus);
    } catch (err) {
      setError(apiErrorMessage(err, 'Run now failed'));
    } finally {
      if (!unmounted.current) setIsDispatching(false);
    }
  };

  const lastRun = status?.lastRun ?? null;
  const runs = status?.runs ?? [];
  const failedSources = lastRun?.sources.filter(source => !source.ok) ?? [];
  const skippedSources = lastRun?.skippedSources ?? [];
  const discoveryDisabled = status?.enabled === false;
  // One in-flight window covers dispatch plus the poll that follows it, so a
  // second click cannot start a second poll loop racing the first.
  const isBusy = isDispatching || isWaiting;

  return (
    <SectionCard
      title="Discovery"
      body="custom"
      data-testid="discovery-status-card"
      action={
        <Stack direction="row" gap={1} alignItems="center">
          {isWaiting && (
            <Stack direction="row" gap={0.75} alignItems="center" role="status" data-testid="discovery-status-waiting">
              <CircularProgress size="sm" aria-hidden />
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Waiting for the run
              </Typography>
            </Stack>
          )}
          {/* A disabled Joy button emits no pointer events, so the tooltip needs the span. */}
          <Tooltip title={discoveryDisabled ? DISABLED_HINT : ''} variant="soft">
            <span>
              <Button
                size="sm"
                variant="plain"
                onClick={runNow}
                disabled={isBusy || discoveryDisabled}
                loading={isDispatching}
                data-testid="model-lifecycle-run-now-btn"
              >
                Run now
              </Button>
            </span>
          </Tooltip>
        </Stack>
      }
    >
      <Stack gap={1} sx={{ px: 2, py: 1.75 }}>
        <Stack direction="row" gap={0.75} alignItems="center" flexWrap="wrap" data-testid="discovery-status-chips">
          <StatusChip
            // 'report' calculates the diff and writes nothing: the safe mode.
            tone={status?.mode === 'write' ? 'warn' : 'neutral'}
            label={`mode: ${status?.mode ?? '...'}`}
            data-testid="discovery-status-mode-chip"
          />
          <StatusChip
            tone="neutral"
            label={`auto-enable: ${status?.autoEnable ?? '...'}`}
            data-testid="discovery-status-autoenable-chip"
          />
          {discoveryDisabled && <StatusChip tone="bad" label="disabled" data-testid="discovery-status-disabled-chip" />}
          {status?.selfHost && (
            <StatusChip tone="neutral" label="self-host" data-testid="discovery-status-selfhost-chip" />
          )}
        </Stack>

        {discoveryDisabled && (
          <Alert color="warning" size="sm" data-testid="discovery-status-disabled-notice">
            {DISABLED_HINT} Turn on Enable Model Discovery in Admin settings to run one.
          </Alert>
        )}

        {error && status && (
          <Alert color="danger" size="sm" data-testid="discovery-status-error">
            {error}
          </Alert>
        )}
        {notice && !error && (
          <Alert color="neutral" size="sm" data-testid="discovery-status-notice">
            {notice}
          </Alert>
        )}

        {!status ? (
          error ? (
            <Box data-testid="discovery-status-error">
              <ErrorState message={error} onRetry={retryLoad} />
            </Box>
          ) : (
            <LoadingState label="Loading discovery status" testId="discovery-status-loading" />
          )
        ) : lastRun ? (
          <Stack gap={0.5}>
            <Stack direction="row" columnGap={0.75} rowGap={0.5} alignItems="center" flexWrap="wrap">
              <StatusChip
                tone={STATUS_TONE[lastRun.status] ?? 'neutral'}
                label={lastRun.status}
                data-testid="discovery-status-run-chip"
              />
              <Typography level="body-xs" data-testid="discovery-status-last-run">
                {lastRun.trigger} on {lastRun.host}, started {formatTime(lastRun.startedAt)}
                {lastRun.finishedAt ? `, finished ${formatTime(lastRun.finishedAt)}` : ', still running'}
              </Typography>
            </Stack>
            <Stack direction="row" columnGap={1.5} rowGap={0.25} alignItems="center" flexWrap="wrap">
              {/* The tally stays over attempts so it never conflates a skip with a
                  failure; a run with no attempt at all says so instead of "0/0". */}
              <Typography level="body-xs" data-testid="discovery-status-sources">
                {lastRun.sources.length > 0
                  ? `${lastRun.sources.length - failedSources.length}/${lastRun.sources.length} sources ok`
                  : 'no sources attempted'}
              </Typography>
              {skippedSources.length > 0 && (
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-skipped">
                  {skippedSources.length} skipped: {skippedSources.map(skipped => skipped.name).join(', ')}
                </Typography>
              )}
              {failedSources.length > 0 && (
                <Link
                  level="body-xs"
                  component="button"
                  onClick={() => setShowFailures(v => !v)}
                  data-testid="discovery-status-failures-toggle"
                >
                  {showFailures ? 'hide' : 'show'} failures
                </Link>
              )}
              {lastRun.joinCoverage.map(coverage => (
                <Typography
                  key={coverage.aggregator}
                  level="body-xs"
                  sx={{ color: 'admin.inkMuted' }}
                  data-testid={`discovery-status-coverage-${coverage.aggregator}`}
                >
                  {coverage.aggregator} {coverage.matched}/{coverage.total}
                </Typography>
              ))}
              {/* No id means there is no report to open, so it stays a sentence. */}
              {lastRun.id ? (
                <Link
                  level="body-xs"
                  component="button"
                  onClick={() => setDetailRunId(lastRun.id)}
                  data-testid="discovery-status-changes"
                >
                  {changeSummary(lastRun.changes)}
                </Link>
              ) : (
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-changes">
                  {changeSummary(lastRun.changes)}
                </Typography>
              )}
            </Stack>
            {showFailures &&
              failedSources.map(source => (
                <Typography
                  key={source.name}
                  level="body-xs"
                  sx={{ color: 'admin.danger' }}
                  data-testid={`discovery-status-failure-${source.name}`}
                >
                  {source.name}: {source.error ?? 'failed'}
                </Typography>
              ))}
            <Stack direction="row" columnGap={1.5} rowGap={0.25} alignItems="center" flexWrap="wrap">
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Last success: {formatTime(status?.lastSuccessfulRunAt)}
              </Typography>
              {runs.length > 1 && (
                <Link
                  level="body-xs"
                  component="button"
                  onClick={() => setShowHistory(v => !v)}
                  data-testid="discovery-status-history-toggle"
                >
                  {showHistory ? 'hide' : 'show'} run history ({runs.length})
                </Link>
              )}
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-retention">
                {RUN_RETENTION_NOTE}
              </Typography>
            </Stack>
            {showHistory && (
              <Stack gap={0.25} data-testid="discovery-status-history-list">
                {runs.map(run => (
                  <Link
                    key={run.id}
                    level="body-xs"
                    component="button"
                    onClick={() => setDetailRunId(run.id)}
                    sx={{ display: 'block', textAlign: 'left' }}
                    data-testid={`discovery-status-history-run-${run.id}`}
                  >
                    {formatTime(run.startedAt)} - {run.trigger} - {run.status} - {changeSummary(run.changes)}
                  </Link>
                ))}
              </Stack>
            )}
          </Stack>
        ) : (
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="discovery-status-never-run">
            Discovery has not run yet.
          </Typography>
        )}
      </Stack>

      <DiscoveryRunDetailModal runId={detailRunId} onClose={() => setDetailRunId(null)} />
    </SectionCard>
  );
};

export default DiscoveryStatusCard;
