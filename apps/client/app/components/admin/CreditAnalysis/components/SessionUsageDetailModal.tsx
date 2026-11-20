import React from 'react';
import { Box, Chip, Divider, Link, Stack, Typography } from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import { formatCredits, formatUsd, modelKey, modelLabel } from '../utils/format';
import { useSessionUsage } from '../hooks/useSessionUsage';
import { AdminDialog, DataTable, EmptyState, ErrorState, LoadingState } from '../../shared';

const num = (n: number) => n.toLocaleString();

/**
 * Admin drill-down: why a session cost what it did. Spend by quest and by model
 * (from usage events) plus each agent execution's per-model iteration billing.
 * Opened from a Ledger row's session link. See /api/admin/session-usage.
 */
export const SessionUsageDetailModal: React.FC<{
  sessionId: string | null;
  onClose: () => void;
  /** Fixed org for the owner/manager surface; the server requires it for non-admins. */
  organizationId?: string;
}> = ({ sessionId, onClose, organizationId }) => {
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useSessionUsage(sessionId, organizationId);
  const usage = data?.usage;

  return (
    <AdminDialog
      open={!!sessionId}
      onClose={onClose}
      title="Session usage"
      width={860}
      data-testid="session-usage-modal"
    >
      <Stack direction="row" alignItems="center" spacing={1} sx={{ pr: 4 }}>
        {sessionId && (
          <Link
            level="body-xs"
            startDecorator={<OpenInNewIcon sx={{ fontSize: 14 }} />}
            onClick={() => navigate({ to: '/notebooks/$id', params: { id: sessionId } })}
            sx={{ cursor: 'pointer' }}
            data-testid="session-usage-open-notebook"
          >
            open notebook
          </Link>
        )}
      </Stack>
      <Typography level="body-xs" sx={{ fontFamily: 'monospace', color: 'neutral.500', mb: 1 }}>
        {sessionId}
      </Typography>

      {error ? (
        <ErrorState
          message={error instanceof Error ? error.message : 'Failed to load session usage'}
          onRetry={() => void refetch()}
        />
      ) : isLoading || !data ? (
        <LoadingState label="Loading session usage" />
      ) : (
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Chip color="primary" variant="soft" data-testid="session-usage-total-credits">
              {formatCredits(usage?.totals.creditsCharged ?? 0)} credits
            </Chip>
            <Chip color="neutral" variant="soft">
              {formatUsd(usage?.totals.cogsUsd ?? 0)} COGS
            </Chip>
            <Chip color="neutral" variant="soft">
              {num(usage?.totals.requests ?? 0)} requests
            </Chip>
            <Chip color="neutral" variant="soft">
              {num(usage?.totals.inputTokens ?? 0)} in / {num(usage?.totals.outputTokens ?? 0)} out tokens
            </Chip>
          </Stack>

          <DetailTable
            title="By quest"
            keyLabel="Quest"
            testid="session-usage-quest-table"
            rows={(usage?.byQuest ?? []).map(q => ({
              key: q.requestId,
              label: q.requestId,
              requests: q.requests,
              inputTokens: q.inputTokens,
              outputTokens: q.outputTokens,
              cogsUsd: q.cogsUsd,
              creditsCharged: q.creditsCharged,
            }))}
          />

          <DetailTable
            title="By model"
            keyLabel="Model"
            testid="session-usage-model-table"
            rows={(usage?.byModel ?? []).map(m => ({
              key: modelKey(m),
              label: modelLabel(m),
              requests: m.requests,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
              cogsUsd: m.cogsUsd,
              creditsCharged: m.creditsCharged,
            }))}
          />

          <Box>
            <Typography level="title-sm" sx={{ mb: 1 }}>
              Agent executions ({data?.executions.length ?? 0})
            </Typography>
            {(data?.executions ?? []).length === 0 ? (
              <Typography level="body-sm" color="neutral">
                No agent executions in this session.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {(data?.executions ?? []).map(ex => (
                  <Box key={ex.executionId} sx={{ p: 1, borderRadius: 'sm', bgcolor: 'background.level1' }}>
                    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                      <Typography level="body-xs" sx={{ fontFamily: 'monospace' }}>
                        {ex.executionId}
                      </Typography>
                      {ex.parentExecutionId && (
                        <Chip size="sm" variant="outlined" color="neutral">
                          subagent
                        </Chip>
                      )}
                      {ex.status && (
                        <Chip size="sm" variant="soft" color="neutral">
                          {ex.status}
                        </Chip>
                      )}
                      <Box sx={{ flex: 1 }} />
                      <Typography level="body-xs" color="neutral">
                        {ex.iterationCount} iters
                      </Typography>
                      <Chip size="sm" variant="soft" color="primary">
                        {formatCredits(ex.totalCreditsUsed)} credits
                      </Chip>
                    </Stack>
                    {ex.byModel.length > 0 && (
                      <>
                        <Divider sx={{ my: 0.5 }} />
                        <DataTable
                          label={`Models for execution ${ex.executionId}`}
                          rows={ex.byModel}
                          getRowId={row => row.model}
                          pagination={false}
                          onRetry={() => void refetch()}
                          columns={[
                            { id: 'model', label: 'Model', render: row => row.model },
                            { id: 'iters', label: 'Iters', numeric: true, render: row => row.iterations },
                            { id: 'in', label: 'In', numeric: true, render: row => num(row.inputTokens) },
                            { id: 'out', label: 'Out', numeric: true, render: row => num(row.outputTokens) },
                            {
                              id: 'credits',
                              label: 'Credits',
                              numeric: true,
                              render: row => formatCredits(row.credits),
                            },
                          ]}
                        />
                      </>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
    </AdminDialog>
  );
};

type DetailRow = {
  key: string;
  label: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cogsUsd: number;
  creditsCharged: number;
};

const DetailTable: React.FC<{ title: string; keyLabel: string; testid: string; rows: DetailRow[] }> = ({
  title,
  keyLabel,
  testid,
  rows,
}) => (
  <Box>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      {title}
    </Typography>
    <DataTable
      label={title}
      testId={testid}
      rows={rows}
      getRowId={row => row.key}
      onRetry={() => {}}
      pagination={false}
      maxHeight="240px"
      empty={<EmptyState title="No usage recorded" action={null} />}
      columns={[
        { id: 'label', label: keyLabel, render: row => <span title={row.label}>{row.label}</span> },
        { id: 'requests', label: 'Requests', numeric: true, render: row => num(row.requests) },
        { id: 'in', label: 'In', numeric: true, render: row => num(row.inputTokens) },
        { id: 'out', label: 'Out', numeric: true, render: row => num(row.outputTokens) },
        { id: 'cogs', label: 'COGS', numeric: true, render: row => formatUsd(row.cogsUsd) },
        { id: 'credits', label: 'Credits', numeric: true, render: row => formatCredits(row.creditsCharged) },
      ]}
    />
  </Box>
);
