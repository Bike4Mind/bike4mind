import React from 'react';
import { Box, Link, Stack, Typography } from '@mui/joy';
import type { AuditEntry } from '@bike4mind/common';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { RelativeTime } from '../../../shared';

const BADGES: Readonly<Record<AuditEntry['category'], { text: string; tone: AdminStatusTone }>> = {
  credits: { text: 'CR', tone: 'warn' },
  access: { text: 'AC', tone: 'info' },
  identity: { text: 'IN', tone: 'good' },
  account: { text: 'AD', tone: 'neutral' },
  org: { text: 'OR', tone: 'neutral' },
  settings: { text: 'ST', tone: 'neutral' },
  support: { text: 'SP', tone: 'info' },
};

/** Compact event rows (icon tile, summary, reason and actor, time) used by Overview and the Admin log. */
export const AuditTimeline: React.FC<{
  entries: readonly AuditEntry[];
  /** Makes each summary a link that opens the entry. */
  onSelect?: (entry: AuditEntry) => void;
  'data-testid'?: string;
}> = ({ entries, onSelect, 'data-testid': testId }) => (
  <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }} data-testid={testId}>
    {entries.map(entry => {
      const badge = BADGES[entry.category];
      return (
        <Stack
          key={entry.id}
          component="li"
          direction="row"
          gap={1.5}
          alignItems="flex-start"
          sx={{
            px: 2,
            py: 1.5,
            '& + &': { borderTop: '1px solid', borderColor: 'admin.border' },
          }}
          data-testid="audit-timeline-row"
        >
          <Box
            aria-hidden
            sx={{
              flex: 'none',
              width: 28,
              height: 28,
              borderRadius: 8,
              display: 'grid',
              placeItems: 'center',
              fontSize: 11,
              fontWeight: 600,
              bgcolor: `admin.status.${badge.tone}.background`,
              color: `admin.status.${badge.tone}.foreground`,
            }}
          >
            {badge.text}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="body-sm" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
              {onSelect ? (
                <Link
                  component="button"
                  type="button"
                  color="neutral"
                  onClick={() => onSelect(entry)}
                  sx={{ color: 'inherit', textAlign: 'left' }}
                  data-testid="audit-timeline-open-btn"
                >
                  {entry.summary}
                </Link>
              ) : (
                entry.summary
              )}
            </Typography>
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
              {[entry.reason && `Reason: ${entry.reason}`, `by ${entry.actor.name}`].filter(Boolean).join(' \u00b7 ')}
            </Typography>
          </Box>
          <Typography level="body-xs" sx={{ color: 'admin.inkMuted', flex: 'none' }}>
            <RelativeTime at={entry.occurredAt} />
          </Typography>
        </Stack>
      );
    })}
  </Box>
);
