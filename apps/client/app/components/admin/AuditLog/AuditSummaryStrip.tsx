import { useState } from 'react';
import { Alert, Button, ButtonGroup, Card, Stack, Typography } from '@mui/joy';
import { AUDIT_SUMMARY_WINDOWS, type AuditLogFilters, type AuditSummaryWindow } from '@bike4mind/common';
import { useAuditSummary } from '@client/app/hooks/data/adminAuditLog';
import { AUDIT_SAVED_VIEWS, DENIED_FILTERS } from './auditSavedViews';

const DEFAULT_WINDOW: AuditSummaryWindow = 30;
const TOP_GRANTERS_SHOWN = 3;

const savedViewFilters = (key: string): AuditLogFilters =>
  AUDIT_SAVED_VIEWS.find(view => view.key === key)?.filters ?? {};

type AuditSummaryStripProps = { onApply(filters: AuditLogFilters): void };

type Tile = { key: string; label: string; value: string; detail?: string; filters: AuditLogFilters };

export const AuditSummaryStrip: React.FC<AuditSummaryStripProps> = ({ onApply }) => {
  const [windowDays, setWindowDays] = useState<AuditSummaryWindow>(DEFAULT_WINDOW);
  const { data: summary, isError } = useAuditSummary(windowDays);

  const tiles: Tile[] = summary
    ? [
        {
          key: 'credits',
          label: 'Credit grants',
          value: `${summary.creditGrants.count} grants`,
          detail: summary.creditGrants.topGranters
            .slice(0, TOP_GRANTERS_SHOWN)
            .map(granter => `${granter.name} (${granter.count})`)
            .join(', '),
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
            onClick={() => setWindowDays(days)}
            data-testid={`audit-summary-window-${days}-btn`}
          >
            {days}d
          </Button>
        ))}
      </ButtonGroup>
      {isError && (
        <Alert color="danger" variant="soft" size="sm" data-testid="audit-summary-error">
          Could not load the audit summary.
        </Alert>
      )}
      <Stack direction="row" spacing={1.5} useFlexGap flexWrap="wrap">
        {tiles.map(tile => (
          <Card
            key={tile.key}
            variant="outlined"
            size="sm"
            role="button"
            tabIndex={0}
            data-testid={`audit-summary-tile-${tile.key}`}
            onClick={() => onApply({ ...tile.filters, from: summary?.since })}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
              event.preventDefault();
              onApply({ ...tile.filters, from: summary?.since });
            }}
            sx={{ minWidth: 160, cursor: 'pointer', '&:hover': { borderColor: 'primary.outlinedHoverBorder' } }}
          >
            <Typography level="body-xs">{tile.label}</Typography>
            <Typography level="title-lg">{tile.value}</Typography>
            {tile.detail && <Typography level="body-xs">{tile.detail}</Typography>}
          </Card>
        ))}
      </Stack>
    </Stack>
  );
};
