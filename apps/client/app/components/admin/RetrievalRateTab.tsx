import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Input from '@mui/joy/Input';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { OptionalPathRetrievalRate, RateArm } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import {
  AdminPageHeader,
  EmptyState,
  ErrorState,
  FilterInputLabel,
  FilterToolbar,
  LoadingState,
  StatStrip,
  StatTile,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

/**
 * The measurement behind the per-turn retrieval-routing question (#1394): when the knowledge tools
 * are OFFERED rather than forced, how often does the model actually reach for them?
 *
 * A high rate says the offer alone is doing the work and a classifier would buy latency for little
 * accuracy. A low one says the gap is real and worth routing. The point of the panel is that the
 * question stops being answerable only by whoever is willing to write the aggregation by hand.
 */

type RetrievalRateResponse = {
  summary: OptionalPathRetrievalRate;
  window: {
    startDate: string | null;
    endDate: string | null;
    newestTurnAt: string | null;
    oldestTurnAt: string | null;
  };
  turnsScanned: number;
  truncated: boolean;
  maxTurnsScanned: number;
};

const formatRate = (rate: number | null): string => (rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`);

const formatDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : 'n/a');

/**
 * The share of answerable turns where the model did NOT retrieve - the defect the answerability
 * split exists to isolate. Not derivable as `1 - arm.rate` without care: that expression turns a
 * null (empty arm) into 1, reporting a 100% miss rate over no turns at all.
 */
const missRate = (arm: { turns: number; retrievedTurns: number }): number | null =>
  arm.turns === 0 ? null : (arm.turns - arm.retrievedTurns) / arm.turns;

/**
 * The A/B's verdict: treatment rate minus control rate. Null unless BOTH arms hold turns - a lift
 * measured against an empty control arm is not a small effect, it is no comparison at all, and
 * rendering it as 0 would report the section as having been tried and found useless.
 *
 * Recomputed from the two counts rather than read off `arm.rate` so it cannot contradict either
 * the denominators printed beside it or the empty-control banner, which ask `turns` the same
 * question. Equivalent at the producer, which sets every arm's rate from exactly this ratio.
 */
const rateLift = (treatment: RateArm, control: RateArm): number | null =>
  treatment.turns === 0 || control.turns === 0
    ? null
    : treatment.retrievedTurns / treatment.turns - control.retrievedTurns / control.turns;

/** Signed percentage points, because a difference of rates is not itself a rate. */
const formatLift = (lift: number | null): string =>
  lift === null ? 'n/a' : `${lift < 0 ? '-' : '+'}${Math.abs(lift * 100).toFixed(1)} pp`;

/**
 * A titled group of numbers. It is a page region rather than a card, so its StatStrip is the only
 * surface and no card sits inside another.
 */
function StatSection({
  title,
  description,
  note,
  children,
  'data-testid': testId,
}: {
  title: string;
  description: ReactNode;
  note?: ReactNode;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <Stack component="section" aria-label={title} gap={1.5} sx={{ minWidth: 0 }} data-testid={testId}>
      <Box>
        <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }}>
          {title}
        </Typography>
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
          {description}
        </Typography>
      </Box>
      {children}
      {note && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          {note}
        </Typography>
      )}
    </Stack>
  );
}

// A blank cutoff means "let the server pick", which pins it to the live forced-retrieval floor
// rather than to a number this component invented. Kept as a string so the field can be cleared.
const NO_FILTERS = { startDate: '', endDate: '', answerableMinScore: '' };

export default function RetrievalRateTab() {
  // Filters apply as they change. The pause keeps a typed cutoff or year from running one fold per
  // keystroke, since each fold scans up to maxTurnsScanned turns.
  const {
    value: filters,
    debouncedValue: appliedFilters,
    setValue: setFilters,
    setValueImmediately: applyFilters,
  } = useDebounceValue(NO_FILTERS, 400);

  const { data, isLoading, isFetching, error, refetch } = useQuery<RetrievalRateResponse>({
    queryKey: ['retrievalRate', appliedFilters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (appliedFilters.startDate) params.append('startDate', appliedFilters.startDate);
      if (appliedFilters.endDate) params.append('endDate', appliedFilters.endDate);
      if (appliedFilters.answerableMinScore) params.append('answerableMinScore', appliedFilters.answerableMinScore);
      const response = await api.get(`/api/admin/retrieval-rate?${params.toString()}`);
      return response.data;
    },
    staleTime: 30_000,
  });

  const summary = data?.summary;

  // An empty population is not a zero rate, and the difference is the whole point. Scoped to the
  // two buckets the rates are computed over: forced and unclassified turns can be non-zero while
  // there is still nothing to measure, so the banner says which population is empty rather than
  // claiming the window holds no turns at all.
  const hasNoRatePopulation = useMemo(
    () => Boolean(data) && summary?.offeredTurns === 0 && summary?.forcedSuppressed.turns === 0,
    [data, summary]
  );

  const errorMessage = error
    ? `Could not load the retrieval rate: ${error instanceof Error ? error.message : 'unknown error'}`
    : '';
  const datesApplied = Boolean(appliedFilters.startDate || appliedFilters.endDate);
  const clearDates = () => applyFilters({ ...filters, startDate: '', endDate: '' });

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ minWidth: 0 }} data-testid="admin-retrieval-rate-tab">
      <AdminPageHeader
        title="Retrieval"
        description="How often the model retrieves when the knowledge tools are offered but not forced."
        actions={
          <Button
            size="sm"
            variant="outlined"
            startDecorator={<RefreshIcon />}
            onClick={() => refetch()}
            loading={isFetching}
            data-testid="retrieval-rate-refresh-btn"
          >
            Refresh
          </Button>
        }
      />

      <FilterToolbar data-testid="retrieval-rate-filter-bar">
        <Input
          size="sm"
          type="date"
          startDecorator={<FilterInputLabel>From</FilterInputLabel>}
          value={filters.startDate}
          onChange={e => setFilters({ ...filters, startDate: e.target.value })}
          slotProps={{ input: { 'aria-label': 'Start date' } }}
          data-testid="retrieval-rate-start-input"
        />
        <Input
          size="sm"
          type="date"
          startDecorator={<FilterInputLabel>To</FilterInputLabel>}
          value={filters.endDate}
          onChange={e => setFilters({ ...filters, endDate: e.target.value })}
          slotProps={{ input: { 'aria-label': 'End date' } }}
          data-testid="retrieval-rate-end-input"
        />
        <Input
          size="sm"
          type="number"
          startDecorator={<FilterInputLabel>Answerable cutoff</FilterInputLabel>}
          slotProps={{ input: { min: 0, max: 1, step: 0.05, 'aria-label': 'Answerable cutoff' } }}
          placeholder="default"
          value={filters.answerableMinScore}
          onChange={e => setFilters({ ...filters, answerableMinScore: e.target.value })}
          data-testid="retrieval-rate-cutoff-input"
        />
      </FilterToolbar>

      {isLoading && <LoadingState label="Folding turns" testId="retrieval-rate-loading" />}

      {/* With numbers on screen a failed refresh is a banner above them; with none it takes their place. */}
      {error &&
        (data ? (
          <Alert color="danger" data-testid="retrieval-rate-error">
            {errorMessage}
          </Alert>
        ) : (
          <Box data-testid="retrieval-rate-error">
            <ErrorState message={errorMessage} onRetry={() => void refetch()} retrying={isFetching} />
          </Box>
        ))}

      {summary &&
        !isLoading &&
        (data?.turnsScanned === 0 ? (
          <EmptyState
            title="No turns in this window"
            description="Turns are counted here once users chat with the knowledge tools on offer."
            action={
              datesApplied ? (
                <Button size="sm" variant="outlined" onClick={clearDates} data-testid="retrieval-rate-clear-dates-btn">
                  Clear dates
                </Button>
              ) : null
            }
          />
        ) : (
          <>
            {data?.truncated && (
              <Alert color="warning" data-testid="retrieval-rate-truncated">
                Window exceeds the {data.maxTurnsScanned.toLocaleString()}-turn scan ceiling. These numbers describe the
                most recent {data.turnsScanned.toLocaleString()} turns only ({formatDate(data.window.oldestTurnAt)} to{' '}
                {formatDate(data.window.newestTurnAt)}) - narrow the dates for a rate that covers the whole window.
              </Alert>
            )}

            {hasNoRatePopulation && (
              <Alert color="neutral" data-testid="retrieval-rate-empty">
                No turns in this window reached the optional path, so there is no rate to report. Any forced or
                unclassified turns below are counted but cannot answer this question - a turn only measures the offer
                when the model was free to decline it.
              </Alert>
            )}

            <StatStrip aria-label="Retrieval rate">
              <StatTile
                label="Optional-path retrieval rate"
                value={formatRate(summary.rate)}
                comparison={`${summary.retrievedTurns.toLocaleString()} of ${summary.offeredTurns.toLocaleString()} offered turns`}
              />
              <StatTile
                label="After a forced-retrieval skip"
                value={formatRate(summary.forcedSuppressed.rate)}
                comparison={`${summary.forcedSuppressed.retrievedTurns.toLocaleString()} of ${summary.forcedSuppressed.turns.toLocaleString()} suppressed turns`}
              />
              <StatTile
                label="Forced turns"
                value={summary.forcedTurns.toLocaleString()}
                comparison="Forced retrieval enabled, nothing suppressed it"
              />
              <StatTile
                label="Unclassified"
                value={summary.unclassifiedTurns.toLocaleString()}
                comparison="No mode recorded - pre-deploy turns, agent-mode runs, or a tool-only write"
              />
            </StatStrip>

            {/* The type says this is always present - the fold never omits it - but the client trusts a
               live HTTP response, not the fold directly, and a response from an API pod one deploy behind
               the client bundle predates this field. Guard rather than crash the whole tab over it. */}
            {summary.answerability && (
              <StatSection
                title="Could the corpus have answered?"
                description={
                  <>
                    Offered turns split by whether an offline replay found anything in the corpus at or above a cosine
                    of {summary.answerability.cutoff.toFixed(2)}. A turn where the model did not retrieve is only a
                    defect if there was something to find.
                  </>
                }
                note="Replayed after the fact, not measured during the turn: the corpus may have moved since, and for turns where retrieval never ran the lake scope is reconstructed from the session as it stands now. Treat a replay run long after the window as weak evidence."
                data-testid="retrieval-rate-answerability"
              >
                {summary.answerability.unknown.turns === summary.offeredTurns && summary.offeredTurns > 0 ? (
                  <Alert color="neutral" data-testid="retrieval-rate-answerability-unreplayed">
                    No turn in this window has been replayed, so the split below is empty. Run the answerability replay
                    (packages/scripts/retrieval/answerability-replay.ts) over this window to populate it.
                  </Alert>
                ) : (
                  <StatStrip aria-label="Answerability split">
                    <StatTile
                      label="Missed retrievals"
                      value={formatRate(missRate(summary.answerability.answerable))}
                      comparison={`${(
                        summary.answerability.answerable.turns - summary.answerability.answerable.retrievedTurns
                      ).toLocaleString()} of ${summary.answerability.answerable.turns.toLocaleString()} answerable turns where the model did not search`}
                    />
                    <StatTile
                      label="Wasted retrievals"
                      value={formatRate(summary.answerability.notAnswerable.rate)}
                      comparison={`${summary.answerability.notAnswerable.retrievedTurns.toLocaleString()} of ${summary.answerability.notAnswerable.turns.toLocaleString()} turns with nothing to find where it searched anyway`}
                    />
                    <StatTile
                      label="Not replayed"
                      value={summary.answerability.unknown.turns.toLocaleString()}
                      comparison={`Excluded from both figures${
                        summary.answerability.inconclusiveTurns > 0
                          ? `, including ${summary.answerability.inconclusiveTurns.toLocaleString()} whose scan hit its ceiling below the cutoff`
                          : ''
                      }`}
                    />
                  </StatStrip>
                )}
              </StatSection>
            )}

            {/* Guarded for the same reason the answerability section above is: a response from an API
               pod one deploy behind the client bundle predates the field. */}
            {summary.guidance && (
              <StatSection
                title="Does the when-to-retrieve guidance help?"
                description="Offered turns split by whether the knowledge-base when-to-retrieve section shipped on the turn. The control arm is produced by clearing the KnowledgeBaseRetrievalPrompt admin setting, which needs no deploy to throw."
                note="The arms are whatever traffic arrived, not a matched sample: they are not balanced on answerability, so a lift over few turns can be a difference in the questions asked rather than in the section. A non-zero Unrecorded count means the window reaches back before the flag shipped - narrow the dates to drop those turns rather than reading them as a third arm."
                data-testid="retrieval-rate-guidance"
              >
                {/* Unlike the answerability split, the arms stay visible with no control traffic: the
                   treatment arm is the live rate and is worth reading on its own. */}
                {summary.guidance.injected.turns > 0 && summary.guidance.notInjected.turns === 0 && (
                  <Alert color="neutral" data-testid="retrieval-rate-guidance-no-control">
                    No offered turn in this window ran with the section cleared, so there is no control arm and no lift
                    to read. Clear the KnowledgeBaseRetrievalPrompt admin setting to open one.
                  </Alert>
                )}

                <StatStrip aria-label="Guidance arms">
                  <StatTile
                    label="Lift from guidance"
                    value={formatLift(rateLift(summary.guidance.injected, summary.guidance.notInjected))}
                    comparison="Retrieval rate with the section minus the rate without it"
                  />
                  <StatTile
                    label="With guidance"
                    value={formatRate(summary.guidance.injected.rate)}
                    comparison={`${summary.guidance.injected.retrievedTurns.toLocaleString()} of ${summary.guidance.injected.turns.toLocaleString()} turns carrying the section`}
                  />
                  <StatTile
                    label="Without guidance"
                    value={formatRate(summary.guidance.notInjected.rate)}
                    comparison={`${summary.guidance.notInjected.retrievedTurns.toLocaleString()} of ${summary.guidance.notInjected.turns.toLocaleString()} turns with the setting cleared`}
                  />
                  <StatTile
                    label="Unrecorded"
                    value={summary.guidance.unrecorded.turns.toLocaleString()}
                    comparison="Excluded from both arms - offered turns from before the flag shipped, not a control group"
                  />
                </StatStrip>
              </StatSection>
            )}

            <StatSection
              title="Forced retrieval suppressed by"
              description="These turns had forced retrieval enabled, but a rule suppressed it and left the model on the offered tool - the same position as an optional turn, reached a different way."
              data-testid="retrieval-rate-suppressed"
            >
              <StatStrip aria-label="Suppression reasons">
                <StatTile
                  label="Attached files"
                  value={
                    <span data-testid="retrieval-rate-skip-attached-files">
                      {summary.forcedSuppressed.byReason.attached_files.toLocaleString()}
                    </span>
                  }
                />
                <StatTile
                  label="Personal corpus"
                  value={
                    <span data-testid="retrieval-rate-skip-personal-corpus">
                      {summary.forcedSuppressed.byReason.personal_corpus.toLocaleString()}
                    </span>
                  }
                />
                <StatTile
                  label="No lake scope"
                  value={
                    <span data-testid="retrieval-rate-skip-no-lake-scope">
                      {summary.forcedSuppressed.byReason.no_lake_scope.toLocaleString()}
                    </span>
                  }
                />
              </StatStrip>
            </StatSection>

            <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }} data-testid="retrieval-rate-window">
              {data?.turnsScanned.toLocaleString()} turns scanned, {formatDate(data?.window.oldestTurnAt ?? null)} to{' '}
              {formatDate(data?.window.newestTurnAt ?? null)}
            </Typography>
          </>
        ))}
    </Stack>
  );
}
