import React from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Stack, Typography } from '@mui/joy';
import { StatusChip } from '@client/app/components/admin/shared';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import { formatLastChecked, integrationStatusView } from '../utils/integrationStatus';
import type { IntegrationDashboardEntry, CircuitBreakerMode, IntegrationName, InMemoryBreakerState } from '../types';

interface IntegrationCardProps {
  entry: IntegrationDashboardEntry;
  isExpanded: boolean;
  onToggle: () => void;
  inMemoryBreakers: Record<string, InMemoryBreakerState>;
  onOverride: (integration: IntegrationName, mode: CircuitBreakerMode, reason?: string) => void;
  isUpdatingOverride: boolean;
}

const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  slack: 'Slack',
  github: 'GitHub',
  jira: 'Jira',
  confluence: 'Confluence',
};

/** One row of the integrations list; expands in place to the detail panel. */
export const IntegrationCard: React.FC<IntegrationCardProps> = ({
  entry,
  isExpanded,
  onToggle,
  inMemoryBreakers,
  onOverride,
  isUpdatingOverride,
}) => {
  const { tone, label } = integrationStatusView(entry);
  const checked = !!entry.lastCheckedAt;

  return (
    <Accordion expanded={isExpanded} onChange={onToggle} data-testid={`integration-card-${entry.name}`}>
      <AccordionSummary sx={{ '& .MuiAccordionSummary-button': { py: 1.5, px: 2 } }}>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          gap={1}
          sx={{ width: '100%' }}
        >
          <Stack direction="row" alignItems="center" gap={1.5}>
            <Typography level="title-md" sx={{ color: 'admin.ink' }}>
              {INTEGRATION_LABELS[entry.name] ?? entry.name}
            </Typography>
            <StatusChip tone={tone} label={label} data-testid={`integration-status-${entry.name}`} />
          </Stack>

          <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
            {checked && (
              <>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums' }}>
                  {entry.latencyMs.toLocaleString()} ms
                </Typography>
                <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontVariantNumeric: 'tabular-nums' }}>
                  {(entry.successRate * 100).toFixed(0)}% success
                </Typography>
              </>
            )}
            {entry.consecutiveFailures > 0 && (
              <StatusChip tone="bad" label={`${entry.consecutiveFailures} consecutive failures`} />
            )}
            {!entry.circuitBreaker.available && <StatusChip tone="bad" label="Circuit open" />}
            {entry.rateLimit?.wasThrottled && <StatusChip tone="warn" label="Throttled" />}
            <Typography
              level="body-xs"
              sx={{ color: 'admin.inkMuted' }}
              title={entry.lastCheckedAt ? new Date(entry.lastCheckedAt).toUTCString() : undefined}
              data-testid={`integration-last-checked-${entry.name}`}
            >
              {checked ? `Checked ${formatLastChecked(entry.lastCheckedAt)}` : 'Never checked'}
            </Typography>
          </Stack>
        </Stack>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 2, pb: isExpanded ? 2 : 0 }}>
        <IntegrationDetailPanel
          entry={entry}
          isExpanded={isExpanded}
          inMemoryBreakers={inMemoryBreakers}
          onOverride={onOverride}
          isUpdatingOverride={isUpdatingOverride}
        />
      </AccordionDetails>
    </Accordion>
  );
};
