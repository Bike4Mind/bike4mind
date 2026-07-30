import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Link, Sheet, Stack, Tooltip, Typography } from '@mui/joy';
import type { ColorPaletteProp } from '@mui/joy/styles';
import { api } from '@client/app/contexts/ApiContext';

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

interface DiscoveryRunSummary {
  startedAt: string;
  finishedAt?: string | null;
  trigger: string;
  host: string;
  status: 'ok' | 'partial' | 'failed';
  sources: DiscoverySource[];
  joinCoverage: DiscoveryJoinCoverage[];
  changes: { added: number; promoted: number; deprecated: number; repriced: number; flagged: number };
}

interface DiscoveryStatus {
  lastRun: DiscoveryRunSummary | null;
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

const STATUS_COLOR: Record<DiscoveryRunSummary['status'], ColorPaletteProp> = {
  ok: 'success',
  partial: 'warning',
  failed: 'danger',
};

const apiErrorMessage = (err: unknown, fallback: string) => {
  const e = err as { response?: { data?: { message?: string } }; message?: string };
  return e?.response?.data?.message || e?.message || fallback;
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const formatTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '-');

const changeSummary = (changes: DiscoveryRunSummary['changes']) => {
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
 */
export const DiscoveryStatusCard: React.FC = () => {
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [showFailures, setShowFailures] = useState(false);

  // The poll loop outlives a fast unmount (2 minutes of it), so every state
  // write past an await is gated on this.
  const unmounted = useRef(false);
  useEffect(
    () => () => {
      unmounted.current = true;
    },
    []
  );

  const load = useCallback(async (): Promise<DiscoveryStatus> => {
    const res = await api.get<DiscoveryStatus>('/api/admin/model-discovery');
    if (!unmounted.current) setStatus(res.data);
    return res.data;
  }, []);

  useEffect(() => {
    void load().catch(err => setError(apiErrorMessage(err, 'Failed to load discovery status')));
  }, [load]);

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
            if (!unmounted.current) setNotice(`Run finished: ${latest.lastRun.status}.`);
            return;
          }
        }
        if (!unmounted.current) setNotice(giveUpMessage(sawNewRun, latest.enabled !== false));
      } finally {
        if (!unmounted.current) setIsWaiting(false);
      }
    },
    [load]
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
  const failedSources = lastRun?.sources.filter(source => !source.ok) ?? [];
  const discoveryDisabled = status?.enabled === false;
  // One in-flight window covers dispatch plus the poll that follows it, so a
  // second click cannot start a second poll loop racing the first.
  const isBusy = isDispatching || isWaiting;

  return (
    <Sheet variant="outlined" sx={{ p: 1.5, borderRadius: 'sm' }} data-testid="discovery-status-card">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
        <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap">
          <Typography level="title-sm">Discovery</Typography>
          <Chip
            size="sm"
            variant="soft"
            // 'report' calculates the diff and writes nothing: the safe mode.
            color={status?.mode === 'write' ? 'warning' : 'success'}
            data-testid="discovery-status-mode-chip"
          >
            {status?.mode ?? '...'}
          </Chip>
          <Chip size="sm" variant="soft" color="neutral" data-testid="discovery-status-autoenable-chip">
            auto-enable: {status?.autoEnable ?? '...'}
          </Chip>
          {discoveryDisabled && (
            <Chip size="sm" variant="soft" color="danger" data-testid="discovery-status-disabled-chip">
              disabled
            </Chip>
          )}
          {status?.selfHost && (
            <Chip size="sm" variant="outlined" color="neutral">
              self-host
            </Chip>
          )}
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          {isWaiting && <CircularProgress size="sm" data-testid="discovery-status-waiting" />}
          {/* A disabled Joy button emits no pointer events, so the tooltip needs the span. */}
          <Tooltip title={discoveryDisabled ? DISABLED_HINT : ''} variant="soft">
            <span>
              <Button
                size="sm"
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
      </Stack>

      {discoveryDisabled && (
        <Alert color="warning" size="sm" sx={{ mt: 1 }} data-testid="discovery-status-disabled-notice">
          {DISABLED_HINT} Turn on Enable Model Discovery in Admin settings to run one.
        </Alert>
      )}

      {error && (
        <Alert color="danger" size="sm" sx={{ mt: 1 }} data-testid="discovery-status-error">
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert color="neutral" size="sm" sx={{ mt: 1 }} data-testid="discovery-status-notice">
          {notice}
        </Alert>
      )}

      {lastRun ? (
        <Box sx={{ mt: 1 }}>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap">
            <Chip size="sm" color={STATUS_COLOR[lastRun.status]} data-testid="discovery-status-run-chip">
              {lastRun.status}
            </Chip>
            <Typography level="body-xs" data-testid="discovery-status-last-run">
              {lastRun.trigger} on {lastRun.host}, started {formatTime(lastRun.startedAt)}
              {lastRun.finishedAt ? `, finished ${formatTime(lastRun.finishedAt)}` : ', still running'}
            </Typography>
          </Stack>
          <Stack direction="row" spacing={0.75} alignItems="center" flexWrap="wrap" sx={{ mt: 0.5 }}>
            <Typography level="body-xs" data-testid="discovery-status-sources">
              {lastRun.sources.length - failedSources.length}/{lastRun.sources.length} sources ok
            </Typography>
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
              <Chip
                key={coverage.aggregator}
                size="sm"
                variant="outlined"
                data-testid={`discovery-status-coverage-${coverage.aggregator}`}
              >
                {coverage.aggregator} {coverage.matched}/{coverage.total}
              </Chip>
            ))}
            <Typography level="body-xs" color="neutral" data-testid="discovery-status-changes">
              {changeSummary(lastRun.changes)}
            </Typography>
          </Stack>
          {showFailures &&
            failedSources.map(source => (
              <Typography
                key={source.name}
                level="body-xs"
                color="danger"
                data-testid={`discovery-status-failure-${source.name}`}
              >
                {source.name}: {source.error ?? 'failed'}
              </Typography>
            ))}
          <Typography level="body-xs" color="neutral" sx={{ mt: 0.5 }}>
            Last success: {formatTime(status?.lastSuccessfulRunAt)}
          </Typography>
        </Box>
      ) : (
        <Typography level="body-xs" color="neutral" sx={{ mt: 1 }} data-testid="discovery-status-never-run">
          Discovery has not run yet.
        </Typography>
      )}
    </Sheet>
  );
};

export default DiscoveryStatusCard;
