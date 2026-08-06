import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Chip, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { api } from '@client/app/contexts/ApiContext';
import { ISpendReconciliation } from '@bike4mind/common';

const signedUsd = (value: number) => `${value < 0 ? '-' : '+'}$${Math.abs(value).toFixed(2)}`;

const statusFromDelta = (
  deltaPct: number
): { color: 'success' | 'warning' | 'danger'; label: string; Icon: React.ElementType } => {
  if (deltaPct < 2) return { color: 'success', label: 'match', Icon: CheckCircleOutlineIcon };
  if (deltaPct <= 10) return { color: 'warning', label: 'review', Icon: WarningAmberIcon };
  return { color: 'danger', label: 'gap', Icon: ErrorOutlineIcon };
};

export const ReconciliationBanner: React.FC = () => {
  const [rows, setRows] = useState<ISpendReconciliation[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await api.get<{ reconciliations: ISpendReconciliation[] }>(
        '/api/admin/spend-reconciliation?view=latest'
      );
      setRows(res.data.reconciliations);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load reconciliation data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  if (isLoading && !rows) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 1 }}>
        <CircularProgress size="sm" />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert color="danger" size="sm" data-testid="reconciliation-banner-error">
        Reconciliation: {error}
      </Alert>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <Alert color="neutral" size="sm" variant="soft" data-testid="reconciliation-banner-empty">
        <Typography level="body-sm">
          No provider spend reconciliation data yet. Configure ANTHROPIC_ADMIN_API_KEY / OPENAI_ADMIN_API_KEY to enable
          nightly reconciliation.
        </Typography>
      </Alert>
    );
  }

  // Compute worst status across all providers for the banner color.
  const worstDelta = Math.max(...rows.map(r => r.deltaPct));
  const overall = statusFromDelta(worstDelta);

  return (
    <Alert
      color={overall.color}
      size="sm"
      variant="soft"
      startDecorator={<overall.Icon />}
      data-testid="reconciliation-banner"
      endDecorator={
        <IconButton size="sm" variant="plain" color={overall.color} onClick={fetch} disabled={isLoading}>
          <RefreshIcon fontSize="small" />
        </IconButton>
      }
    >
      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Typography level="title-sm">Provider Reconciliation</Typography>
        {rows.map(row => {
          const status = statusFromDelta(row.deltaPct);
          return (
            <Tooltip
              key={row.provider}
              title={`${row.month}: provider $${row.providerUsd.toFixed(2)} vs internal $${row.internalUsd.toFixed(2)} (${signedUsd(row.deltaUsd)}, ${row.deltaPct.toFixed(1)}%)${row.note ? ` -- ${row.note}` : ''}`}
            >
              <Chip size="sm" color={status.color} variant="solid" data-testid={`reconciliation-chip-${row.provider}`}>
                {row.provider}: {signedUsd(row.deltaUsd)} ({row.deltaPct.toFixed(1)}%)
              </Chip>
            </Tooltip>
          );
        })}
      </Stack>
    </Alert>
  );
};
