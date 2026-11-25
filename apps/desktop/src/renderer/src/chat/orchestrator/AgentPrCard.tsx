import { useEffect, useState } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Typography from '@mui/joy/Typography';
import type { PrIconStatus } from '@shared/prAttention';
import type { PrBarState } from '@shared/pullRequest';
import { CI_DOT_COLOR } from '../prBarModel';
import { ciSummary } from '@shared/pullRequest';
import { ciLine, freshnessLine, mergeLine, PR_LEGEND, prHeadline, reviewLine } from '../prPlainWords';
import { PrStateIcon } from '../prStateStyle';

/**
 * Reads the agent's PR once when shown, then follows the monitor's pushes until it closes. No timer:
 * getState answers from the monitor's cache and only asks GitHub when that is over its staleness limit.
 */
function usePrBarState(sessionId: string): { state: PrBarState | null; settled: boolean } {
  const [state, setState] = useState<PrBarState | null>(null);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let live = true;
    let pushed = false;
    const unsubscribe = window.b4m.pullRequests.onStateChanged(next => {
      if (!live || next.sessionId !== sessionId) return;
      pushed = true;
      setState(next);
      setSettled(true);
    });
    window.b4m.pullRequests
      .getState(sessionId)
      .then(initial => {
        if (live && !pushed) setState(initial);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setSettled(true);
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [sessionId]);
  return { state, settled };
}

function Row({ label, value, testId, dot }: { label: string; value: string; testId: string; dot?: string }) {
  return (
    <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline' }}>
      <Typography level="body-xs" textColor="text.tertiary" sx={{ width: 52, flexShrink: 0 }}>
        {label}
      </Typography>
      {dot && (
        <Box
          aria-hidden
          sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: dot, flexShrink: 0, alignSelf: 'center' }}
        />
      )}
      <Typography level="body-xs" data-testid={testId}>
        {value}
      </Typography>
    </Box>
  );
}

export function PrLegend() {
  return (
    <Box
      component="ul"
      data-testid="orchestrator-pr-legend"
      sx={{ listStyle: 'none', m: 0, p: 0, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.5 }}
    >
      {PR_LEGEND.map(({ status, label }) => (
        <Box component="li" key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <PrStateIcon status={status} size={14} />
          <Typography level="body-xs">{label}</Typography>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The PR badge's hover card: the state in plain words, then CI, review and merge lines from the
 * monitor's last read. `status` is the summary the badge already draws, so the headline shows at once
 * and never disagrees with the icon.
 */
export function AgentPrCard({
  sessionId,
  number,
  status,
  onOpenPage,
  onOpenDetails,
}: {
  sessionId: string;
  number: number;
  status: PrIconStatus;
  onOpenPage?(url: string | undefined): void;
  onOpenDetails?(): void;
}) {
  const { state, settled } = usePrBarState(sessionId);
  const [showLegend, setShowLegend] = useState(false);
  const snapshot = state?.binding && !state.binding.dismissed ? state.snapshot : null;
  const headline = prHeadline(status);
  const freshness = snapshot ? freshnessLine(snapshot, Date.now()) : null;
  return (
    <Box
      data-testid="orchestrator-pr-card"
      sx={{ width: 280, display: 'flex', flexDirection: 'column', gap: 0.75, p: 0.5 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ pt: 0.25, display: 'flex' }}>
          <PrStateIcon status={status} size={18} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography level="title-sm" data-testid="orchestrator-pr-card-headline">
            {headline.title}
            {status.state === 'open' && status.behind && status.attention !== 'conflict' ? ', behind base' : ''}
          </Typography>
          {headline.hint && (
            <Typography level="body-xs" textColor="text.secondary">
              {headline.hint}
            </Typography>
          )}
        </Box>
      </Box>
      <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }} data-testid="orchestrator-pr-card-title">
        <Typography component="span" textColor="text.tertiary">{`#${number} `}</Typography>
        {snapshot?.title ?? ''}
      </Typography>
      {snapshot ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          <Row
            label="CI"
            value={ciLine(snapshot.checks)}
            dot={CI_DOT_COLOR[ciSummary(snapshot.checks)]}
            testId="orchestrator-pr-card-ci"
          />
          <Row label="Review" value={reviewLine(snapshot.reviewDecision)} testId="orchestrator-pr-card-review" />
          <Row label="Merge" value={mergeLine(snapshot)} testId="orchestrator-pr-card-merge" />
          {status.autoMerge && (
            <Row label="" value="Merges on its own once it can" testId="orchestrator-pr-card-auto" />
          )}
        </Box>
      ) : (
        <Typography level="body-xs" textColor="text.tertiary" role="status">
          {settled ? 'Details are not available right now.' : 'Reading details...'}
        </Typography>
      )}
      {(freshness || status.stale) && (
        <Typography level="body-xs" textColor="text.tertiary" data-testid="orchestrator-pr-card-fresh">
          {[freshness, status.stale ? 'last known state' : null].filter(Boolean).join(' - ')}
        </Typography>
      )}
      <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
        {onOpenPage && (
          <Button
            size="sm"
            variant="solid"
            data-testid="orchestrator-pr-card-open"
            onClick={() => onOpenPage(snapshot?.url)}
          >
            Open on GitHub
          </Button>
        )}
        {onOpenDetails && (
          <Button size="sm" variant="plain" data-testid="orchestrator-pr-card-details" onClick={onOpenDetails}>
            Details
          </Button>
        )}
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          aria-expanded={showLegend}
          data-testid="orchestrator-pr-card-legend-toggle"
          onClick={() => setShowLegend(shown => !shown)}
          sx={{ ml: 'auto' }}
        >
          {showLegend ? 'Hide key' : 'Icon key'}
        </Button>
      </Box>
      {showLegend && <PrLegend />}
      {onOpenDetails && (
        <Typography level="body-xs" textColor="text.tertiary">
          Shift-click the badge for details.
        </Typography>
      )}
    </Box>
  );
}
