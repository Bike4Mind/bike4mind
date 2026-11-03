import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { LocalUsage, LocalUsageResult, LocalUsageRow } from '@shared/usage';
import { formatTokens } from '../chat/statusLine';
import { formatSeconds, formatTokenRate } from '../chat/tokenRate';
import { Stat } from './Stat';
import { UsageBarChart } from './UsageBarChart';
import { BreakdownCard, type BreakdownMetric } from './UsageBreakdown';
import { WINDOW_LABELS, formatCount } from './usageView';

function replies(count: number): string {
  return `${formatCount(count)} ${count === 1 ? 'reply' : 'replies'}`;
}

function formatOutput(tokens: number): string {
  return `${formatTokens(tokens)} tok`;
}

/** The server-timed rate where there is one, else the stream-timed estimate, marked as such. */
function rowRate(row: LocalUsageRow): string | null {
  return (
    formatTokenRate({ evalTokens: row.evalTokens, evalMs: row.evalMs }) ??
    formatTokenRate({ evalTokens: row.estimatedEvalTokens, evalMs: row.estimatedEvalMs, estimated: true })
  );
}

const LOCAL_METRIC: BreakdownMetric<LocalUsageRow> = {
  value: row => row.outputTokens,
  format: formatOutput,
  extras: row => {
    const rate = rowRate(row);
    return rate ? [replies(row.replies), rate] : [replies(row.replies)];
  },
};

/** The card for an answer, a one-line error for a failed read, and nothing while reading. */
export function LocalUsageSection({ result }: { result: LocalUsageResult | null }) {
  if (!result) return null;
  if (!result.ok) {
    return (
      <Typography level="body-sm" color="warning" sx={{ mb: 1.5 }} data-testid="profile-local-error">
        {result.error}
      </Typography>
    );
  }
  return <LocalUsageCard usage={result.usage} />;
}

/**
 * Replies from self-hosted models in the window: how many, how much they wrote, and how fast.
 *
 * Every figure is counted in main from the conversations stored on this device; none of it comes
 * from, or goes to, a server. Renders nothing for a window with no local replies, and leaves out
 * each speed figure no server reported.
 */
export function LocalUsageCard({ usage }: { usage: LocalUsage }) {
  const { totals } = usage;
  if (totals.replies === 0) return null;

  const windowLabel = WINDOW_LABELS[usage.window].toLowerCase();
  const generation = formatTokenRate({ evalTokens: totals.evalTokens, evalMs: totals.evalMs });
  const estimated = formatTokenRate({
    evalTokens: totals.estimatedEvalTokens,
    evalMs: totals.estimatedEvalMs,
    estimated: true,
  });
  const prompt = formatTokenRate({ evalTokens: totals.promptTokens, evalMs: totals.promptMs });

  return (
    <Box data-testid="profile-local-usage">
      <Sheet variant="outlined" sx={{ borderRadius: 'sm', px: 2, py: 1.75, mb: 1.5 }} data-testid="profile-local-card">
        <Typography level="title-sm">Self-hosted models</Typography>
        <Typography level="body-xs" textColor="text.tertiary" sx={{ mb: 1.25 }}>
          Counted on this device from your saved conversations. None of it is sent anywhere.
        </Typography>
        <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
          <Stat label="Replies" value={formatCount(totals.replies)} testId="profile-local-replies" />
          <Stat
            label="Output tokens"
            value={formatTokens(totals.outputTokens)}
            caption={`${formatTokens(totals.contextTokens)} context tokens`}
            testId="profile-local-output"
          />
          {generation && (
            <Stat
              label="Generation"
              value={generation}
              caption={`timed ${formatCount(totals.timedReplies)} of ${replies(totals.replies)}`}
              testId="profile-local-generation"
            />
          )}
          {estimated && (
            <Stat
              label="Estimated generation"
              value={estimated}
              caption={`${replies(totals.estimatedReplies)} timed by this app`}
              testId="profile-local-estimated"
            />
          )}
          {prompt && <Stat label="Prompt" value={prompt} testId="profile-local-prompt" />}
          {totals.loads > 0 && (
            <Stat
              label="Avg load time"
              value={formatSeconds(totals.loadMs / totals.loads)}
              caption="per timed Ollama reply"
              testId="profile-local-load"
            />
          )}
          {totals.draftTokens > 0 && (
            <Stat
              label="Draft acceptance"
              value={`${Math.round((totals.draftAccepted / totals.draftTokens) * 100)}%`}
              caption={`${formatCount(totals.draftAccepted)} of ${formatCount(totals.draftTokens)} tokens`}
              testId="profile-local-draft"
            />
          )}
        </Stack>
      </Sheet>

      <UsageBarChart
        title="Self-hosted output tokens"
        total={formatTokens(totals.outputTokens)}
        bars={usage.bars}
        granularity={usage.granularity}
        metric="outputTokens"
        color="neutral"
        format={formatOutput}
        emptyMessage={`No output tokens reported in the ${windowLabel}.`}
        testId="profile-local-chart"
      />

      <BreakdownCard
        title="By self-hosted model"
        caption="Output tokens per model, across every server."
        rows={usage.byModel}
        metric={LOCAL_METRIC}
        testId="profile-local-model-breakdown"
      />
      <BreakdownCard
        title="By server"
        caption="Where the model ran."
        rows={usage.byServer}
        metric={LOCAL_METRIC}
        testId="profile-local-server-breakdown"
      />
    </Box>
  );
}
