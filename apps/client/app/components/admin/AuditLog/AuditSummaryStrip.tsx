import { Box, Button, ButtonGroup, Skeleton, Stack } from '@mui/joy';
import { ErrorState, StatTile } from '../shared';
import {
  AUDIT_SUMMARY_WINDOWS,
  type AuditLogFilters,
  type AuditSummary,
  type AuditSummaryWindow,
} from '@bike4mind/common';
import { useAuditSummary } from '@client/app/hooks/data/adminAuditLog';
import { AUDIT_SAVED_VIEWS, DENIED_FILTERS } from './auditSavedViews';

const TOP_GRANTERS_SHOWN = 3;

const savedViewFilters = (key: string): AuditLogFilters =>
  AUDIT_SAVED_VIEWS.find(view => view.key === key)?.filters ?? {};

type AuditSummaryStripProps = {
  windowDays: AuditSummaryWindow;
  onWindowChange(windowDays: AuditSummaryWindow): void;
  onApply(filters: AuditLogFilters): void;
};

const formatCredits = (credits: number) => credits.toLocaleString('en-US');

const creditTileDetail = ({ count, deductedCredits, topGranters }: AuditSummary['creditGrants']): string => {
  const counts = `${count} grants${deductedCredits > 0 ? `, -${formatCredits(deductedCredits)} deducted` : ''}`;
  const granters = topGranters
    .slice(0, TOP_GRANTERS_SHOWN)
    .map(granter => `${granter.name} (${granter.count})`)
    .join(', ');
  return granters ? `${counts}: ${granters}` : counts;
};

type Tile = { key: string; label: string; value: string; detail?: string; filters: AuditLogFilters };

export const AuditSummaryStrip: React.FC<AuditSummaryStripProps> = ({ windowDays, onWindowChange, onApply }) => {
  const { data: summary, isError, isLoading, refetch } = useAuditSummary(windowDays);

  const tiles: Tile[] = summary
    ? [
        {
          key: 'credits',
          label: 'Credit grants',
          value: `+${formatCredits(summary.creditGrants.grantedCredits)} credits`,
          detail: creditTileDetail(summary.creditGrants),
          filters: savedViewFilters('credits'),
        },
        {
          key: 'access',
          label: 'Permission changes',
          value: String(summary.permissionChanges),
          filters: savedViewFilters('access'),
        },
        {
          key: 'impersonation',
          label: 'Impersonations',
          value: String(summary.impersonations),
          filters: savedViewFilters('impersonation'),
        },
        {
          key: 'deletions',
          label: 'Deletions',
          value: String(summary.deletions),
          filters: savedViewFilters('deletions'),
        },
        { key: 'denied', label: 'Denied attempts', value: String(summary.deniedAttempts), filters: DENIED_FILTERS },
      ]
    : [];

  return (
    <Stack spacing={1} data-testid="audit-summary-strip">
      <ButtonGroup size="sm" variant="outlined" aria-label="Summary window">
        {AUDIT_SUMMARY_WINDOWS.map(days => (
          <Button
            key={days}
            variant={days === windowDays ? 'solid' : 'outlined'}
            onClick={() => onWindowChange(days)}
            data-testid={`audit-summary-window-${days}-btn`}
          >
            {days}d
          </Button>
        ))}
      </ButtonGroup>
      {isError && (
        <Box data-testid="audit-summary-error">
          <ErrorState message="Could not load the audit summary." onRetry={() => void refetch()} />
        </Box>
      )}
      {isLoading && <Skeleton variant="rectangular" height="6rem" data-testid="audit-summary-loading" />}
      <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
        {tiles.map(tile => (
          <Box
            key={tile.key}
            component="button"
            type="button"
            data-testid={`audit-summary-tile-${tile.key}`}
            onClick={() => onApply({ ...tile.filters, from: summary?.since })}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onApply({ ...tile.filters, from: summary?.since });
            }}
            sx={{
              minWidth: '10rem',
              flex: '1 1 10rem',
              p: 0,
              border: 0,
              bgcolor: 'transparent',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            <StatTile label={tile.label} value={tile.value} comparison={tile.detail} />
          </Box>
        ))}
      </Stack>
    </Stack>
  );
};
