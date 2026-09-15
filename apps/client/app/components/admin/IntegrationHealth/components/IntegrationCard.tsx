import React from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Chip, Stack, Typography } from '@mui/joy';
import { IntegrationDetailPanel } from './IntegrationDetailPanel';
import type { IntegrationDashboardEntry, CircuitBreakerMode, IntegrationName, InMemoryBreakerState } from '../types';

interface IntegrationCardProps {
  entry: IntegrationDashboardEntry;
  isExpanded: boolean;
  onToggle: () => void;
  inMemoryBreakers: Record<string, InMemoryBreakerState>;
  onOverride: (integration: IntegrationName, mode: CircuitBreakerMode, reason?: string) => void;
  isUpdatingOverride: boolean;
}

const STATUS_CONFIG: Record<string, { color: 'success' | 'warning' | 'danger'; label: string }> = {
  healthy: { color: 'success', label: 'Healthy' },
  degraded: { color: 'warning', label: 'Degraded' },
  unhealthy: { color: 'danger', label: 'Down' },
};

const STATUS_FALLBACK = { color: 'danger' as const, label: 'Unknown' };

const INTEGRATION_LABELS: Record<IntegrationName, string> = {
  slack: 'Slack',
  github: 'GitHub',
  jira: 'Jira',
  confluence: 'Confluence',
};

export const IntegrationCard: React.FC<IntegrationCardProps> = ({
  entry,
  isExpanded,
  onToggle,
  inMemoryBreakers,
  onOverride,
  isUpdatingOverride,
}) => {
  const { color, label } = STATUS_CONFIG[entry.status] ?? STATUS_FALLBACK;
  const timeSinceCheck = entry.lastCheckedAt ? formatTimeSince(new Date(entry.lastCheckedAt)) : 'never';

  return (
    <Accordion
      expanded={isExpanded}
      onChange={onToggle}
      data-testid={`integration-card-${entry.name}`}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 'sm',
        overflow: 'hidden',
      }}
    >
      <AccordionSummary
        sx={{
          '& .MuiAccordionSummary-button': {
            py: 1.5,
            px: 2,
          },
        }}
      >
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          justifyContent="space-between"
          spacing={1}
          sx={{ width: '100%' }}
        >
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <Typography level="title-md">{INTEGRATION_LABELS[entry.name] ?? entry.name}</Typography>
            <Chip size="sm" variant="solid" color={color}>
              {label}
            </Chip>
          </Stack>

          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <Typography level="body-xs" color="neutral">
              {entry.latencyMs}ms
            </Typography>
            <Typography level="body-xs" color="neutral">
              {(entry.successRate * 100).toFixed(0)}% success
            </Typography>
            {entry.consecutiveFailures > 0 && (
              <Chip size="sm" color="danger" variant="soft">
                {entry.consecutiveFailures} consecutive failures
              </Chip>
            )}
            {!entry.circuitBreaker.available && (
              <Chip size="sm" color="danger" variant="soft">
                Circuit Open
              </Chip>
            )}
            {entry.rateLimit?.wasThrottled && (
              <Chip size="sm" color="warning" variant="soft">
                Throttled
              </Chip>
            )}
            <Typography level="body-xs" color="neutral">
              checked {timeSinceCheck}
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

function formatTimeSince(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
