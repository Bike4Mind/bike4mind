import React from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Link,
  Modal,
  ModalClose,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import { formatCredits, formatUsd, numberCell } from '../utils/format';
import { useSessionUsage } from '../hooks/useSessionUsage';

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
  const { data, isLoading, error } = useSessionUsage(sessionId, organizationId);
  const usage = data?.usage;

  return (
    <Modal open={!!sessionId} onClose={onClose}>
      <ModalDialog
        sx={{ width: 'min(860px, 96vw)', maxHeight: '90vh', overflow: 'auto' }}
        data-testid="session-usage-modal"
      >
        <ModalClose />
        <Stack direction="row" alignItems="center" spacing={1} sx={{ pr: 4 }}>
          <Typography level="title-md">Session usage</Typography>
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

        {error && (
          <Alert color="danger" sx={{ mb: 1 }} data-testid="session-usage-error">
            {(error as Error)?.message || 'Failed to load session usage'}
          </Alert>
        )}

        {isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
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
                key: `${m.provider}-${m.model}`,
                label: `${m.provider} / ${m.model}`,
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
                    <Sheet key={ex.executionId} variant="soft" sx={{ p: 1, borderRadius: 'sm' }}>
                      <Stack
                        direction="row"
                        alignItems="center"
                        spacing={1}
                        flexWrap="wrap"
                        useFlexGap
                        sx={{ mb: 0.5 }}
                      >
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
                          <Table size="sm" sx={{ '--TableCell-paddingY': '2px' }}>
                            <thead>
                              <tr>
                                <th>Model</th>
                                <th style={{ textAlign: 'right' }}>Iters</th>
                                <th style={{ textAlign: 'right' }}>In</th>
                                <th style={{ textAlign: 'right' }}>Out</th>
                                <th style={{ textAlign: 'right' }}>Credits</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ex.byModel.map(m => (
                                <tr key={m.model}>
                                  <td>{m.model}</td>
                                  <td style={{ textAlign: 'right', ...numberCell }}>{m.iterations}</td>
                                  <td style={{ textAlign: 'right', ...numberCell }}>{num(m.inputTokens)}</td>
                                  <td style={{ textAlign: 'right', ...numberCell }}>{num(m.outputTokens)}</td>
                                  <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(m.credits)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </Table>
                        </>
                      )}
                    </Sheet>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        )}
      </ModalDialog>
    </Modal>
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
    <Sheet variant="outlined" sx={{ borderRadius: 'sm', maxHeight: 240, overflow: 'auto' }}>
      <Table stickyHeader size="sm" data-testid={testid}>
        <thead>
          <tr>
            <th>{keyLabel}</th>
            <th style={{ textAlign: 'right' }}>Requests</th>
            <th style={{ textAlign: 'right' }}>In</th>
            <th style={{ textAlign: 'right' }}>Out</th>
            <th style={{ textAlign: 'right' }}>COGS</th>
            <th style={{ textAlign: 'right' }}>Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key}>
              <td title={r.label} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.label}
              </td>
              <td style={{ textAlign: 'right', ...numberCell }}>{num(r.requests)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{num(r.inputTokens)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{num(r.outputTokens)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatUsd(r.cogsUsd)}</td>
              <td style={{ textAlign: 'right', ...numberCell }}>{formatCredits(r.creditsCharged)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6}>
                <Typography level="body-sm" color="neutral">
                  No usage recorded.
                </Typography>
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </Sheet>
  </Box>
);
