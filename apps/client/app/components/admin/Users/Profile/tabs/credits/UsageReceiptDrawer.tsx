import React from 'react';
import { Box, Drawer, IconButton, Stack, Typography } from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import type { AdminUsageReceipt, AdminUsageReceiptCall, AdminUsageReceiptQuery } from '@bike4mind/common';
import { useAdminUsageReceipt } from '@client/app/hooks/data/adminUserCredits';
import { ErrorState, Fact, SectionCard, StatusChip } from '../../../../shared';
import { formatCreditDelta, formatCredits } from '../../actions/creditAdjustment';

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  web: 'Web app',
  cli: 'CLI',
  desktop: 'Desktop app',
  api: 'API',
  agent: 'Agent',
  system: 'System',
};

const OPERATION_LABELS: Readonly<Record<string, string>> = {
  notebook_naming: 'Notebook naming',
  notebook_summary: 'Notebook summary',
  notebook_tagging: 'Notebook tagging',
  context_summary: 'Context summarization',
  memento: 'Memory extraction',
};

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  chat: 'Chat message',
  operations: 'Background job',
  embedding: 'Search embedding',
  completion_api: 'API completion',
};

const tokens = (value: number) => value.toLocaleString('en-US');
const NOT_RECORDED = 'Not recorded for this request';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatLatency = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const sourceLabel = (call: AdminUsageReceiptCall): string => {
  const source = call.source ? (SOURCE_LABELS[call.source] ?? call.source) : 'Unclassified';
  if (call.operation) return `${source} \u00b7 ${OPERATION_LABELS[call.operation] ?? call.operation}`;
  const feature = FEATURE_LABELS[call.feature] ?? call.feature.replace(/_/g, ' ');
  return `${source} \u00b7 ${feature}`;
};

const CallReceipt: React.FC<{ call: AdminUsageReceiptCall; index: number; count: number }> = ({
  call,
  index,
  count,
}) => {
  const { limits } = call;
  const title = count > 1 ? `Call ${index + 1} of ${count}` : 'Call';
  return (
    <Stack gap={2} data-testid="usage-receipt-call">
      <SectionCard
        title={title}
        action={call.status !== 'ok' ? <StatusChip tone="warn" label={call.status} /> : undefined}
      >
        <Fact label="Time">{new Date(call.at).toLocaleString()}</Fact>
        <Fact label="Model">
          {call.model}
          {call.executedModel ? ` (ran on ${call.executedModel})` : ''}
        </Fact>
        <Fact label="Source" data-testid="usage-receipt-source">
          {sourceLabel(call)}
          {call.apiKeyPrefix ? ` \u00b7 key ${call.apiKeyPrefix}` : ''}
        </Fact>
        <Fact label="Stop reason">{call.stopReason}</Fact>
        <Fact label="Latency">{call.latencyMs !== undefined ? formatLatency(call.latencyMs) : undefined}</Fact>
      </SectionCard>

      <SectionCard title="Credits" data-testid="usage-receipt-credits">
        <Fact label="Cost">{formatCredits(call.credits.cost)}</Fact>
        <Fact label="Charged" data-testid="usage-receipt-charged">
          {formatCredits(call.credits.charged)}
        </Fact>
        <Fact label="Written off" data-testid="usage-receipt-written-off">
          {call.credits.writtenOff > 0 ? formatCredits(call.credits.writtenOff) : 'None'}
        </Fact>
        <Fact label="Held before the call">
          {call.credits.reserved !== undefined ? formatCredits(call.credits.reserved) : undefined}
        </Fact>
        <Fact label="Provider cost">{`$${call.costUsd.toFixed(4)}`}</Fact>
      </SectionCard>

      <SectionCard title="Tokens" data-testid="usage-receipt-tokens">
        <Fact label="Input">{tokens(call.tokens.input)}</Fact>
        <Fact label="Cache read">{tokens(call.tokens.cacheRead)}</Fact>
        <Fact label="Cache write">{tokens(call.tokens.cacheWrite)}</Fact>
        <Fact label="Visible output">{tokens(call.tokens.visibleOutput)}</Fact>
        <Fact label="Thinking (estimate)" data-testid="usage-receipt-thinking">
          {call.tokens.thinking !== undefined ? tokens(call.tokens.thinking) : undefined}
        </Fact>
        <Fact label="Output billed">{tokens(call.tokens.output)}</Fact>
        <Fact label="Priced on">
          {call.tokens.basis === 'provider'
            ? 'Provider counts'
            : call.tokens.basis === 'local'
              ? 'Local estimate'
              : undefined}
        </Fact>
      </SectionCard>

      <SectionCard title="Limits" data-testid="usage-receipt-limits">
        <Fact label="Balance cap" data-testid="usage-receipt-cap">
          {limits.capBound
            ? limits.creditCapOutputTokens !== undefined
              ? `Bound: output lowered to ${tokens(limits.creditCapOutputTokens)} tokens`
              : 'Bound'
            : call.detailRecorded
              ? 'Did not bind'
              : NOT_RECORDED}
        </Fact>
        <Fact label="Stopped for credits">
          {call.detailRecorded ? (limits.stoppedForCredits ? 'Yes' : 'No') : NOT_RECORDED}
        </Fact>
        <Fact label="Max output">
          {limits.maxOutputTokens !== undefined ? `${tokens(limits.maxOutputTokens)} tokens` : undefined}
        </Fact>
        <Fact label="Reasoning effort">{limits.reasoningEffort}</Fact>
        <Fact label="Thinking budget">
          {limits.thinkingBudgetTokens !== undefined ? `${tokens(limits.thinkingBudgetTokens)} tokens` : undefined}
        </Fact>
      </SectionCard>

      <SectionCard title="Tools and attachments" data-testid="usage-receipt-tools">
        <Fact label="Tool calls">
          {!call.detailRecorded
            ? NOT_RECORDED
            : call.toolCalls.length === 0
              ? 'None'
              : call.toolCalls.map(tool => `${tool.name} x${tool.count}`).join(', ')}
        </Fact>
        <Fact label="Attachments">
          {!call.detailRecorded
            ? NOT_RECORDED
            : call.attachments.count === 0
              ? 'None'
              : `${call.attachments.count} (${formatBytes(call.attachments.totalBytes)})`}
        </Fact>
      </SectionCard>
    </Stack>
  );
};

const LedgerRows: React.FC<{ receipt: AdminUsageReceipt }> = ({ receipt }) =>
  receipt.ledger.length === 0 ? null : (
    <SectionCard title="Ledger rows" data-testid="usage-receipt-ledger">
      {receipt.ledger.map(row => (
        <Fact key={row.id} label={row.type.replace(/_/g, ' ')}>
          {formatCreditDelta(row.credits)}
          {row.writtenOffCredits ? ` charged, ${formatCredits(row.writtenOffCredits)} written off` : ''}
        </Fact>
      ))}
    </SectionCard>
  );

/**
 * What one charged request cost and why, from metadata only: an admin can explain a charge without
 * reading the conversation. The server sends no message text, file names or titles (adminUsageReceiptSchema).
 */
export const UsageReceiptDrawer: React.FC<{
  userId: string;
  target: AdminUsageReceiptQuery | null;
  onClose: () => void;
}> = ({ userId, target, onClose }) => {
  const receipt = useAdminUsageReceipt(userId, target);

  const body = () => {
    if (receipt.isLoading) return <Typography level="body-sm">Loading receipt...</Typography>;
    if (receipt.isError || !receipt.data) {
      return <ErrorState message="The receipt could not be loaded." onRetry={() => void receipt.refetch()} />;
    }
    const { calls, totals } = receipt.data;
    if (calls.length === 0) {
      return (
        <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="usage-receipt-empty">
          No usage was recorded for this request. Charges made before usage recording, and tool-only rows, have no
          receipt.
        </Typography>
      );
    }
    return (
      <Stack gap={2}>
        {calls.length > 1 && (
          <SectionCard title="Total" data-testid="usage-receipt-totals">
            <Fact label="Cost">{formatCredits(totals.cost)}</Fact>
            <Fact label="Charged">{formatCredits(totals.charged)}</Fact>
            <Fact label="Written off">{totals.writtenOff > 0 ? formatCredits(totals.writtenOff) : 'None'}</Fact>
          </SectionCard>
        )}
        {calls.map((call, index) => (
          <CallReceipt key={call.id} call={call} index={index} count={calls.length} />
        ))}
        <LedgerRows receipt={receipt.data} />
      </Stack>
    );
  };

  return (
    <Drawer open={target !== null} onClose={onClose} anchor="right" size="md">
      {target && (
        <Box data-testid="usage-receipt-drawer" sx={{ p: 2, overflow: 'auto' }}>
          <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} sx={{ mb: 2 }}>
            <Stack gap={0.5} sx={{ minWidth: 0 }}>
              <Typography level="title-md">Usage receipt</Typography>
              <Typography level="body-xs" sx={{ fontFamily: 'code', overflowWrap: 'anywhere' }}>
                Request {target.requestId}
              </Typography>
              <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                Metadata only. Message text, file names and titles are never shown.
              </Typography>
            </Stack>
            <IconButton aria-label="Close" onClick={onClose} data-testid="usage-receipt-close-btn">
              <CloseIcon />
            </IconButton>
          </Stack>
          {body()}
        </Box>
      )}
    </Drawer>
  );
};
