import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';

export type StatTileProps = {
  label: string;
  /** A help control beside the label, such as the definition of the term. */
  help?: ReactNode;
  value: ReactNode;
  comparison?: ReactNode;
  sparkline?: ReactNode;
  /** Colors the value by status; reserve it for a value that is itself a status (e.g. risk). */
  valueColor?: string;
};

export function StatTile({ label, help, value, comparison, sparkline, valueColor }: StatTileProps) {
  const labelText = (
    <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
      {label}
    </Typography>
  );
  return (
    <Stack data-testid="admin-stat-tile" gap={0.5} sx={{ px: 2, py: 1.75, minWidth: 0 }}>
      {help ? (
        <Stack direction="row" alignItems="center" gap={0.25}>
          {labelText}
          {/* The negative margin keeps the label row's height; the guide caps help icons at 16 px. */}
          <Box sx={{ display: 'flex', my: -1, '& svg': { fontSize: 16 } }}>{help}</Box>
        </Stack>
      ) : (
        labelText
      )}
      <Stack direction="row" alignItems="flex-end" gap={1.5} sx={{ minWidth: 0 }}>
        <Typography
          component="span"
          sx={{
            color: valueColor ?? 'admin.ink',
            fontSize: 22,
            fontWeight: 600,
            lineHeight: 1.25,
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
            overflowWrap: 'anywhere',
          }}
        >
          {typeof value === 'number' ? value.toLocaleString() : value}
        </Typography>
        {sparkline && <Box sx={{ flex: 1, minWidth: 0 }}>{sparkline}</Box>}
      </Stack>
      {comparison && (
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted', fontWeight: 400 }}>
          {comparison}
        </Typography>
      )}
    </Stack>
  );
}

/**
 * One card holding 3 to 5 tiles, divided by hairlines. Tiles wrap onto new rows on narrow screens;
 * the negative margins hide the dividers that would otherwise sit on the card's outer edge.
 */
export function StatStrip({
  children,
  'aria-label': ariaLabel = 'Key numbers',
}: {
  children: ReactNode;
  'aria-label'?: string;
}) {
  return (
    <Box
      component="section"
      aria-label={ariaLabel}
      data-testid="admin-stat-strip"
      sx={{ ...adminSurface, borderWidth: 1, borderStyle: 'solid', borderRadius: 'lg', overflow: 'hidden' }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          mr: '-1px',
          mb: '-1px',
          '& > *': { borderRight: '1px solid', borderBottom: '1px solid', borderColor: 'admin.border' },
        }}
      >
        {children}
      </Box>
    </Box>
  );
}

/** Inline bar sparkline for a StatTile: `values` are relative heights, scaled to the tallest. */
export function StatSparkline({ values, label }: { values: readonly number[]; label: string }) {
  const max = Math.max(...values, 0);
  return (
    <Box
      role="img"
      aria-label={label}
      data-testid="admin-stat-sparkline"
      sx={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: 28 }}
    >
      {values.map((value, index) => (
        <Box
          key={index}
          sx={{
            flex: 1,
            height: `${max > 0 ? Math.max(4, (value / max) * 100) : 4}%`,
            bgcolor: 'admin.selection.border',
            borderRadius: '2px',
          }}
        />
      ))}
    </Box>
  );
}
