import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Alert from '@mui/joy/Alert';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import Card from '@mui/joy/Card';
import CircularProgress from '@mui/joy/CircularProgress';
import FormControl from '@mui/joy/FormControl';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { OptionalPathRetrievalRate } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

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

function StatCard({ label, value, caption }: { label: string; value: string; caption: string }) {
  return (
    <Card variant="soft" sx={{ flex: '1 1 200px', minWidth: 200 }}>
      <Typography level="body-sm" textColor="text.secondary">
        {label}
      </Typography>
      <Typography level="h2">{value}</Typography>
      <Typography level="body-xs" textColor="text.secondary">
        {caption}
      </Typography>
    </Card>
  );
}

export default function RetrievalRateTab() {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  // Blank means "let the server pick", which pins the cutoff to the live forced-retrieval floor
  // rather than to a number this component invented. Kept as a string so the field can be cleared.
  const [answerableMinScore, setAnswerableMinScore] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ startDate: '', endDate: '', answerableMinScore: '' });

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

  return (
    <Box sx={{ p: 2 }} data-testid="admin-retrieval-rate-tab">
      <Typography level="h3" sx={{ mb: 0.5 }}>
        Retrieval Rate
      </Typography>
      <Typography level="body-sm" textColor="text.secondary" sx={{ mb: 2 }}>
        How often the model retrieves when the knowledge tools are offered but not forced.
      </Typography>

      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <FormControl size="sm">
          <FormLabel>Start date</FormLabel>
          <Input
            type="date"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
            data-testid="retrieval-rate-start-input"
          />
        </FormControl>
        <FormControl size="sm">
          <FormLabel>End date</FormLabel>
          <Input
            type="date"
            value={endDate}
            onChange={e => setEndDate(e.target.value)}
            data-testid="retrieval-rate-end-input"
          />
        </FormControl>
        <FormControl size="sm">
          <FormLabel>Answerable cutoff</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { min: 0, max: 1, step: 0.05 } }}
            placeholder="default"
            value={answerableMinScore}
            onChange={e => setAnswerableMinScore(e.target.value)}
            data-testid="retrieval-rate-cutoff-input"
          />
        </FormControl>
        <Button
          size="sm"
          onClick={() => setAppliedFilters({ startDate, endDate, answerableMinScore })}
          loading={isFetching}
          data-testid="retrieval-rate-apply-btn"
        >
          Apply
        </Button>
        <Button size="sm" variant="outlined" onClick={() => refetch()} data-testid="retrieval-rate-refresh-btn">
          Refresh
        </Button>
      </Stack>

      {isLoading && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }} data-testid="retrieval-rate-loading">
          <CircularProgress size="sm" />
          <Typography level="body-sm">Folding turns...</Typography>
        </Stack>
      )}

      {error && (
        <Alert color="danger" data-testid="retrieval-rate-error">
          {error instanceof Error ? error.message : 'Failed to load the retrieval rate.'}
        </Alert>
      )}

      {summary && !isLoading && (
        <Stack spacing={2}>
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
              unclassified turns below are counted but cannot answer this question - a turn only measures the offer when
              the model was free to decline it.
            </Alert>
          )}

          <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
            <StatCard
              label="Optional-path retrieval rate"
              value={formatRate(summary.rate)}
              caption={`${summary.retrievedTurns.toLocaleString()} of ${summary.offeredTurns.toLocaleString()} offered turns`}
            />
            <StatCard
              label="After a forced-retrieval skip"
              value={formatRate(summary.forcedSuppressed.rate)}
              caption={`${summary.forcedSuppressed.retrievedTurns.toLocaleString()} of ${summary.forcedSuppressed.turns.toLocaleString()} suppressed turns`}
            />
            <StatCard
              label="Forced turns"
              value={summary.forcedTurns.toLocaleString()}
              caption="Forced retrieval enabled, nothing suppressed it"
            />
            <StatCard
              label="Unclassified"
              value={summary.unclassifiedTurns.toLocaleString()}
              caption="No mode recorded - pre-deploy turns, agent-mode runs, or a tool-only write"
            />
          </Stack>

          {/* The type says this is always present - the fold never omits it - but the client trusts a
             live HTTP response, not the fold directly, and a response from an API pod one deploy behind
             the client bundle predates this field. Guard rather than crash the whole tab over it. */}
          {summary.answerability && (
            <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }} data-testid="retrieval-rate-answerability">
              <Typography level="title-sm">Could the corpus have answered?</Typography>
              <Typography level="body-xs" textColor="text.secondary" sx={{ mb: 1.5 }}>
                Offered turns split by whether an offline replay found anything in the corpus at or above a cosine of{' '}
                {summary.answerability.cutoff.toFixed(2)}. A turn where the model did not retrieve is only a defect if
                there was something to find.
              </Typography>

              {summary.answerability.unknown.turns === summary.offeredTurns && summary.offeredTurns > 0 ? (
                <Alert color="neutral" data-testid="retrieval-rate-answerability-unreplayed">
                  No turn in this window has been replayed, so the split below is empty. Run the answerability replay
                  (packages/scripts/retrieval/answerability-replay.ts) over this window to populate it.
                </Alert>
              ) : (
                <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
                  <StatCard
                    label="Missed retrievals"
                    value={formatRate(missRate(summary.answerability.answerable))}
                    caption={`${(
                      summary.answerability.answerable.turns - summary.answerability.answerable.retrievedTurns
                    ).toLocaleString()} of ${summary.answerability.answerable.turns.toLocaleString()} answerable turns where the model did not search`}
                  />
                  <StatCard
                    label="Wasted retrievals"
                    value={formatRate(summary.answerability.notAnswerable.rate)}
                    caption={`${summary.answerability.notAnswerable.retrievedTurns.toLocaleString()} of ${summary.answerability.notAnswerable.turns.toLocaleString()} turns with nothing to find where it searched anyway`}
                  />
                  <StatCard
                    label="Not replayed"
                    value={summary.answerability.unknown.turns.toLocaleString()}
                    caption={`Excluded from both figures${
                      summary.answerability.inconclusiveTurns > 0
                        ? `, including ${summary.answerability.inconclusiveTurns.toLocaleString()} whose scan hit its ceiling below the cutoff`
                        : ''
                    }`}
                  />
                </Stack>
              )}

              <Typography level="body-xs" textColor="text.secondary" sx={{ mt: 1 }}>
                Replayed after the fact, not measured during the turn: the corpus may have moved since, and for turns
                where retrieval never ran the lake scope is reconstructed from the session as it stands now. Treat a
                replay run long after the window as weak evidence.
              </Typography>
            </Sheet>
          )}

          <Sheet variant="outlined" sx={{ p: 2, borderRadius: 'sm' }}>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Forced retrieval suppressed by
            </Typography>
            <Stack direction="row" spacing={3}>
              <Typography level="body-sm" data-testid="retrieval-rate-skip-attached-files">
                Attached files: {summary.forcedSuppressed.byReason.attached_files.toLocaleString()}
              </Typography>
              <Typography level="body-sm" data-testid="retrieval-rate-skip-personal-corpus">
                Personal corpus: {summary.forcedSuppressed.byReason.personal_corpus.toLocaleString()}
              </Typography>
            </Stack>
            <Typography level="body-xs" textColor="text.secondary" sx={{ mt: 1 }}>
              These turns had forced retrieval enabled, but a rule suppressed it and left the model on the offered tool
              - the same position as an optional turn, reached a different way.
            </Typography>
          </Sheet>

          <Typography level="body-xs" textColor="text.secondary" data-testid="retrieval-rate-window">
            {data?.turnsScanned.toLocaleString()} turns scanned, {formatDate(data?.window.oldestTurnAt ?? null)} to{' '}
            {formatDate(data?.window.newestTurnAt ?? null)}
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
