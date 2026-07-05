import React from 'react';
import { Box, Typography, Stack, Tooltip } from '@mui/joy';
import dayjs from 'dayjs';

// Status Log timeline. Shared between the per-message Prompt Metadata inspector
// and the Admin -> Model Metrics -> Raw Data view. Driven entirely by a quest's
// `statusLog` (an array of `{ status, timestamp }`), so any caller with that
// array gets the same waterfall visualization.

export type StatusLogEntry = { status: string; timestamp: string | Date };

/** Human-friendly duration: 850ms, 3.0s, 1m 5s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * Waterfall timeline over the status log. Each row is a stage; its bar starts
 * where the previous stage ended and its width is the gap that elapsed before
 * it - so the longest bar is literally where the time went. The slowest gap is
 * highlighted (warning color) so a bottleneck - queue wait, model latency - is
 * obvious at a glance.
 */
const StatusTimeline: React.FC<{ statusLog: StatusLogEntry[] }> = ({ statusLog }) => {
  if (!statusLog || statusLog.length === 0) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography level="body-sm" sx={{ color: 'text.secondary' }}>
          No status log entries
        </Typography>
      </Box>
    );
  }

  // Chronological order so deltas read top->bottom as the request progresses.
  const sorted = [...statusLog].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  const t0 = new Date(sorted[0].timestamp).getTime();
  const tEnd = new Date(sorted[sorted.length - 1].timestamp).getTime();
  const total = Math.max(tEnd - t0, 1); // guard divide-by-zero when all stamps equal

  // Per-stage gap (delta from previous) + cumulative offset from the start.
  const rows = sorted.map((entry, i) => {
    const t = new Date(entry.timestamp).getTime();
    const prev = i === 0 ? t : new Date(sorted[i - 1].timestamp).getTime();
    return { entry, delta: t - prev, offset: prev - t0, abs: t };
  });
  const maxDelta = Math.max(...rows.map(r => r.delta));

  return (
    <Stack spacing={1.25} sx={{ p: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography level="body-sm" sx={{ fontWeight: 'lg' }}>
          Total elapsed: {formatDuration(total)}
        </Typography>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', fontVariantNumeric: 'tabular-nums' }}>
          {dayjs(t0).format('HH:mm:ss')} → {dayjs(tEnd).format('HH:mm:ss')}
        </Typography>
      </Box>

      {rows.map((row, i) => {
        const isBottleneck = row.delta === maxDelta && row.delta > 0;
        const widthPct = Math.max((row.delta / total) * 100, row.delta > 0 ? 2 : 0);
        const offsetPct = (row.offset / total) * 100;
        return (
          <Tooltip
            key={i}
            arrow
            placement="top"
            title={`${row.entry.status} — ${dayjs(row.abs).format('YYYY-MM-DD HH:mm:ss')}${
              i === 0 ? ' (start)' : ` · +${formatDuration(row.delta)} since previous`
            }`}
          >
            <Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 0.25, gap: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75, flex: 1, minWidth: 0 }}>
                  <Typography
                    level="body-xs"
                    sx={{
                      color: isBottleneck ? 'warning.plainColor' : 'text.primary',
                      fontWeight: isBottleneck ? 'lg' : 'md',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {row.entry.status}
                  </Typography>
                  {/* Absolute timestamp beside the status name. */}
                  <Typography
                    level="body-xs"
                    sx={{ color: 'text.tertiary', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                  >
                    {dayjs(row.abs).format('HH:mm:ss')}
                  </Typography>
                </Box>
                {/* Gap since the previous stage — the "where time went" signal. */}
                <Typography
                  level="body-xs"
                  sx={{
                    flexShrink: 0,
                    color: isBottleneck ? 'warning.plainColor' : 'text.tertiary',
                    fontWeight: isBottleneck ? 'lg' : 'sm',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {i === 0 ? 'start' : `+${formatDuration(row.delta)}`}
                </Typography>
              </Box>
              <Box
                sx={{
                  position: 'relative',
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: 'background.level1',
                  overflow: 'hidden',
                }}
              >
                <Box
                  sx={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: `${offsetPct}%`,
                    width: `${widthPct}%`,
                    minWidth: row.delta > 0 ? '3px' : 0,
                    borderRadius: 4,
                    backgroundColor: isBottleneck ? 'warning.solidBg' : 'primary.solidBg',
                  }}
                />
                {i === 0 && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: 0,
                      width: '3px',
                      borderRadius: 4,
                      backgroundColor: 'neutral.solidBg',
                    }}
                  />
                )}
              </Box>
            </Box>
          </Tooltip>
        );
      })}
    </Stack>
  );
};

export default StatusTimeline;
