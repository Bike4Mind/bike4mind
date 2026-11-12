import { useState } from 'react';
import { Box, Button, Card, Chip, CircularProgress, Input, Stack, Table, Typography } from '@mui/joy';
import type { LoopCoachResponse, LoopCoachSuggestion, LoopCoachTrialSide } from '@bike4mind/common';
import { useLoopCoach, useLoopCoachAction, type LoopCoachAction } from '@client/app/hooks/data/loops';
import { relativeTimeFormat } from '@client/app/utils/dateUtils';
import { formatDuration } from './loopMap';
import { formatCredits } from './loopUi';

// Must match COACH.trial in apps/client/server/utils/loopCoach.ts.
const TRIAL_MIN = 5;
const TRIAL_MAX = 50;
const TRIAL_DEFAULT = 10;
const DISMISS_REASON_MAX = 300;

const BY_LABEL = { owner: 'you', coach: 'the coach', trial: 'a trial', undo: 'undo' } as const;

type Act = (action: LoopCoachAction) => void;

function SuggestionCard({ suggestion, act, busy }: { suggestion: LoopCoachSuggestion; act: Act; busy: boolean }) {
  const [tickets, setTickets] = useState(TRIAL_DEFAULT);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const { key } = suggestion;
  const ticketsValid = Number.isInteger(tickets) && tickets >= TRIAL_MIN && tickets <= TRIAL_MAX;
  return (
    <Card size="sm" variant="outlined" data-testid="loop-coach-suggestion">
      <Stack direction="row" gap={1} alignItems="center">
        <Chip size="sm" variant="soft">
          {suggestion.kind}
        </Chip>
        <Typography level="title-sm">{suggestion.title}</Typography>
      </Stack>
      <Typography level="body-sm" data-testid="loop-coach-evidence">
        {suggestion.evidence}
      </Typography>
      {!suggestion.patch && (
        <Typography level="body-xs" color="neutral">
          Advice only: change the loop yourself if you agree.
        </Typography>
      )}
      {suggestion.disabledReason && (
        <Typography level="body-xs" color="warning" data-testid="loop-coach-disabled-reason">
          {suggestion.disabledReason}
        </Typography>
      )}
      <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
        {suggestion.patch && (
          <Button
            size="sm"
            disabled={busy || !!suggestion.disabledReason}
            onClick={() => act({ action: 'apply', key })}
            data-testid="loop-coach-apply-btn"
          >
            Apply
          </Button>
        )}
        {suggestion.trialable && suggestion.patch && (
          <>
            <Button
              size="sm"
              variant="soft"
              disabled={busy || !ticketsValid}
              onClick={() => act({ action: 'trial', key, tickets })}
              data-testid="loop-coach-trial-btn"
            >
              Trial for
            </Button>
            <Input
              size="sm"
              type="number"
              value={tickets}
              onChange={event => setTickets(Number(event.target.value))}
              endDecorator="tickets"
              sx={{ width: 140 }}
              slotProps={{ input: { min: TRIAL_MIN, max: TRIAL_MAX, 'data-testid': 'loop-coach-trial-tickets-input' } }}
            />
          </>
        )}
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          disabled={busy}
          onClick={() => setDismissing(open => !open)}
          data-testid="loop-coach-dismiss-btn"
        >
          Dismiss
        </Button>
      </Stack>
      {dismissing && (
        <Stack direction="row" gap={1}>
          <Input
            size="sm"
            placeholder="Why not? (required)"
            value={reason}
            onChange={event => setReason(event.target.value)}
            sx={{ flex: 1 }}
            slotProps={{ input: { maxLength: DISMISS_REASON_MAX, 'data-testid': 'loop-coach-dismiss-reason-input' } }}
          />
          <Button
            size="sm"
            variant="soft"
            disabled={busy || !reason.trim()}
            onClick={() => act({ action: 'dismiss', key, reason: reason.trim() })}
            data-testid="loop-coach-dismiss-confirm-btn"
          >
            Dismiss
          </Button>
        </Stack>
      )}
    </Card>
  );
}

const rate = (value: number | null) => (value === null ? '-' : `${Math.round(value * 100)}%`);
const comparisonRows: [string, (side: LoopCoachTrialSide) => string][] = [
  ['Tickets', side => String(side.tickets)],
  ['Rated up / down', side => `${side.up} / ${side.down}`],
  ['Credits per run', side => (side.creditsPerRun === null ? '-' : formatCredits(Math.round(side.creditsPerRun)))],
  ['Median run', side => (side.medianRunMs === null ? '-' : formatDuration(side.medianRunMs))],
  ['Done rate', side => rate(side.doneRate)],
];

function TrialCard({ trial, act, busy }: { trial: NonNullable<LoopCoachResponse['trial']>; act: Act; busy: boolean }) {
  return (
    <Card size="sm" variant="soft" color={trial.complete ? 'success' : 'primary'} data-testid="loop-coach-trial">
      <Typography level="title-sm">
        Trial on {trial.stage}: {trial.model} instead of {trial.baselineModel}
      </Typography>
      <Typography level="body-sm" data-testid="loop-coach-trial-progress">
        {trial.complete ? 'Trial complete: ' : ''}
        {trial.done} of {trial.tickets} tickets
      </Typography>
      {trial.complete && (
        <Table size="sm" data-testid="loop-coach-trial-comparison">
          <thead>
            <tr>
              <th />
              <th>{trial.trial.model} (trial)</th>
              <th>{trial.baseline.model} (30 days before)</th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows.map(([label, value]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{value(trial.trial)}</td>
                <td>{value(trial.baseline)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Typography level="body-xs">The trial model stays until you keep or revert it.</Typography>
      <Stack direction="row" gap={1}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => act({ action: 'keep' })}
          data-testid="loop-coach-trial-keep-btn"
        >
          Keep {trial.model}
        </Button>
        <Button
          size="sm"
          variant="soft"
          disabled={busy}
          onClick={() => act({ action: 'revert' })}
          data-testid="loop-coach-trial-revert-btn"
        >
          Revert
        </Button>
      </Stack>
    </Card>
  );
}

/**
 * The loop coach: rule-based suggestions with their numbers, applied, trialled or dismissed only by the owner, plus
 * the running model trial and the recent settings changes with Undo. Mounted when its accordion opens.
 */
export default function LoopCoach({ loopId }: { loopId: string }) {
  const { data, isLoading } = useLoopCoach(loopId, true);
  const mutation = useLoopCoachAction(loopId);
  const [showDismissed, setShowDismissed] = useState(false);
  if (isLoading) return <CircularProgress size="sm" />;
  if (!data) return <Typography level="body-sm">The coach could not be loaded.</Typography>;
  const act: Act = action => mutation.mutate(action);
  const busy = mutation.isPending;

  return (
    <Stack gap={1.5} data-testid="loop-coach">
      {data.trial && <TrialCard trial={data.trial} act={act} busy={busy} />}
      {data.suggestions.length === 0 ? (
        <Typography level="body-sm" data-testid="loop-coach-empty">
          No suggestions right now. The coach looks at the last 30 days.
        </Typography>
      ) : (
        data.suggestions.map(suggestion => (
          <SuggestionCard key={suggestion.key} suggestion={suggestion} act={act} busy={busy} />
        ))
      )}

      {data.dismissed.length > 0 && (
        <Box>
          <Button
            size="sm"
            variant="plain"
            color="neutral"
            onClick={() => setShowDismissed(open => !open)}
            data-testid="loop-coach-dismissed-toggle"
          >
            Dismissed ({data.dismissed.length})
          </Button>
          {showDismissed &&
            data.dismissed.map(entry => (
              <Stack key={entry.key} direction="row" gap={1} alignItems="center" data-testid="loop-coach-dismissed-row">
                <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                  {entry.key}: {entry.reason}
                </Typography>
                <Button
                  size="sm"
                  variant="plain"
                  disabled={busy}
                  onClick={() => act({ action: 'restore', key: entry.key })}
                  data-testid="loop-coach-restore-btn"
                >
                  Restore
                </Button>
              </Stack>
            ))}
        </Box>
      )}

      {data.versions.length > 0 && (
        <Box data-testid="loop-coach-versions">
          <Typography level="title-sm">Recent changes</Typography>
          {data.versions.map(version => (
            <Stack key={version.id} direction="row" gap={1} alignItems="center" data-testid="loop-version-row">
              <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }}>
                Settings changed by {BY_LABEL[version.by]}: {version.reason} -{' '}
                {relativeTimeFormat(new Date(version.at))}
                {version.undone ? ' (undone)' : ''}
              </Typography>
              {version.undoable && (
                <Button
                  size="sm"
                  variant="plain"
                  disabled={busy}
                  onClick={() => act({ action: 'undo', eventId: version.id })}
                  data-testid="loop-version-undo-btn"
                >
                  Undo
                </Button>
              )}
            </Stack>
          ))}
        </Box>
      )}
    </Stack>
  );
}
