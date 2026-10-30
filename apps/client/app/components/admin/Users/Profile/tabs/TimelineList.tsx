import React from 'react';
import { Box, Link, Skeleton, Stack, Typography } from '@mui/joy';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';

export type TimelineTile = { text: string; tone: AdminStatusTone };

export type TimelineItem = {
  id: string;
  tile: TimelineTile;
  summary: string;
  /** Makes the summary a link-styled button (opens the record). */
  onOpen?: () => void;
  /** Muted second line(s). */
  meta?: React.ReactNode;
  /** Right-aligned, e.g. the relative time. */
  aside: React.ReactNode;
  /** Extra content under the meta line, e.g. a before/after list. */
  extra?: React.ReactNode;
};

/** A 28 px code tile; decorative, since the summary always names the event in words. */
const Tile: React.FC<TimelineTile> = ({ text, tone }) => (
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
      bgcolor: `admin.status.${tone}.background`,
      color: `admin.status.${tone}.foreground`,
    }}
  >
    {text}
  </Box>
);

/** The profile's event rows (tile, summary, meta, time), shared by Overview, Activity and the Admin log. */
export const TimelineList: React.FC<{ items: readonly TimelineItem[]; rowTestId: string; 'data-testid'?: string }> = ({
  items,
  rowTestId,
  'data-testid': testId,
}) => (
  <Box component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }} data-testid={testId}>
    {items.map(item => (
      <Stack
        key={item.id}
        component="li"
        direction="row"
        gap={1.5}
        alignItems="flex-start"
        sx={{ px: 2, py: 1.5, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } }}
        data-testid={rowTestId}
      >
        <Tile {...item.tile} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm" sx={{ color: 'admin.ink', overflowWrap: 'anywhere' }}>
            {item.onOpen ? (
              <Link
                component="button"
                type="button"
                color="neutral"
                onClick={item.onOpen}
                sx={{ color: 'inherit', textAlign: 'left', fontSize: 'inherit' }}
                data-testid={`${rowTestId}-open-btn`}
              >
                {item.summary}
              </Link>
            ) : (
              item.summary
            )}
          </Typography>
          {item.meta && (
            <Typography level="body-xs" sx={{ color: 'admin.inkMuted', overflowWrap: 'anywhere' }}>
              {item.meta}
            </Typography>
          )}
          {item.extra}
        </Box>
        <Box sx={{ flex: 'none', textAlign: 'right', '& time': { fontSize: 12 } }}>{item.aside}</Box>
      </Stack>
    ))}
  </Box>
);

/** Loading rows shaped like the timeline. */
export const TimelineSkeleton: React.FC<{ rows?: number }> = ({ rows = 5 }) => (
  <Box data-testid="timeline-skeleton" aria-busy="true">
    {Array.from({ length: rows }, (_, index) => (
      <Stack
        key={index}
        direction="row"
        gap={1.5}
        sx={{ px: 2, py: 1.5, '& + &': { borderTop: '1px solid', borderColor: 'admin.border' } }}
      >
        <Skeleton variant="rectangular" width={28} height={28} sx={{ borderRadius: 8 }} />
        <Box sx={{ flex: 1 }}>
          <Skeleton variant="text" level="body-sm" width="55%" />
          <Skeleton variant="text" level="body-xs" width="30%" />
        </Box>
        <Skeleton variant="text" level="body-xs" width={56} />
      </Stack>
    ))}
  </Box>
);
