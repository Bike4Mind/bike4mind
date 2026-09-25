import { ORG_FEEDBACK_SUMMARY_TAG_LIMIT } from '@bike4mind/common';
import FeedbackCountTable, { tagTruncationCaption } from '@client/app/components/organizations/FeedbackCountTable';
import { type OrgFeedbackRange, useOrgFeedbackReport } from '@client/app/hooks/data/orgFeedbackReport';
import { useOrgFeedbackSummary } from '@client/app/hooks/data/useOrgFeedbackSummary';
import { promoteInlineLatexDollars, remarkGfmNoSingleTilde } from '@client/app/utils/remarkPlugins';
import { Alert, Box, Button, Card, CircularProgress, Stack, Typography } from '@mui/joy';
import { FC, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

/**
 * Heading/paragraph mapping mirrors MarkdownViewer's, minus the code-block and Mermaid chrome
 * a written summary never needs. Keep the LLM-markdown plugin choices (remarkGfmNoSingleTilde,
 * promoteInlineLatexDollars) in sync with Knowledge/MarkdownViewer.tsx.
 */
const summaryMarkdownComponents = {
  p: ({ children }: { children?: ReactNode }) => (
    <Typography component="p" level="body-md" sx={{ mb: 1 }}>
      {children}
    </Typography>
  ),
  h1: ({ children }: { children?: ReactNode }) => (
    <Typography component="h1" level="title-lg" sx={{ mb: 1 }}>
      {children}
    </Typography>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <Typography component="h2" level="title-md" sx={{ mb: 1 }}>
      {children}
    </Typography>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <Typography component="h3" level="title-sm" sx={{ mb: 1 }}>
      {children}
    </Typography>
  ),
};

/**
 * The written summary for the window the Analysis shell has applied.
 *
 * Shares the shell's range with the counts panel, and reads the counts through the same query key,
 * so the aggregate is fetched once and the two panels cannot disagree about the window.
 */
const OrgFeedbackSummaryPanel: FC<{ organizationId: string; range: OrgFeedbackRange }> = ({
  organizationId,
  range,
}) => {
  const report = useOrgFeedbackReport(organizationId, range, { enabled: true });
  const { data, isLoading, generate } = useOrgFeedbackSummary(organizationId, range);

  const status = data?.status ?? 'none';
  const running = status === 'pending' || status === 'processing';
  // Only once the counts are in: an undefined total is "not loaded yet", not "nothing to say".
  const empty = report.data?.totals.count === 0;

  const body = () => {
    if (empty) {
      return (
        <Typography level="body-md" data-testid="feedback-summary-empty-state">
          No feedback in this period, so there is nothing to summarize.
        </Typography>
      );
    }
    if (running) {
      return (
        <Stack direction="row" spacing={1.5} alignItems="center" data-testid="feedback-summary-pending-spinner">
          <CircularProgress size="sm" />
          <Typography level="body-md">Writing the summary. This takes a moment.</Typography>
        </Stack>
      );
    }
    if (status === 'failed') {
      return (
        <Alert color="danger" data-testid="feedback-summary-error-alert">
          {data?.errorMessage || 'The summary could not be generated.'}
        </Alert>
      );
    }
    if (status === 'completed' && data?.artifact) {
      const storedTags = data.artifact.counts.byTag.slice(0, ORG_FEEDBACK_SUMMARY_TAG_LIMIT);
      return (
        <Stack spacing={1}>
          <Typography level="body-xs">
            Covering {data.artifact.range.from.slice(0, 10)} to {data.artifact.range.to.slice(0, 10)}
          </Typography>
          <Box data-testid="feedback-summary-result-text">
            <ReactMarkdown
              remarkPlugins={[remarkGfmNoSingleTilde, [remarkMath, { singleDollarTextMath: false }]]}
              rehypePlugins={[rehypeKatex]}
              components={summaryMarkdownComponents}
            >
              {promoteInlineLatexDollars(data.artifact.summary)}
            </ReactMarkdown>
          </Box>
          {/* Only the rows the summary worker fed the model (same shared limit as orgFeedbackSummary.ts),
              so the table matches the prose. Untagged rows are absent, so these do not sum to the total. */}
          <FeedbackCountTable
            title="By tag"
            testId="feedback-summary-by-tag"
            rows={storedTags}
            caption={
              data.artifact.counts.byTagTruncated || data.artifact.counts.byTag.length > storedTags.length
                ? tagTruncationCaption(storedTags.length, 'stored')
                : undefined
            }
          />
        </Stack>
      );
    }
    return (
      <Typography level="body-md" data-testid="feedback-summary-idle">
        Generate a written read of this window, built from the counts above.
      </Typography>
    );
  };

  return (
    <Card variant="outlined">
      <Stack spacing={2}>
        <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between">
          <Typography level="title-md">Summary</Typography>
          <Button
            size="sm"
            data-testid="feedback-summary-generate-button"
            loading={generate.isPending}
            disabled={running || empty || isLoading}
            onClick={() => generate.mutate()}
          >
            {status === 'failed' || status === 'completed' ? 'Regenerate' : 'Generate'}
          </Button>
        </Stack>
        {body()}
      </Stack>
    </Card>
  );
};

export default OrgFeedbackSummaryPanel;
