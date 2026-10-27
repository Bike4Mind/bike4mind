import { Box } from '@mui/joy';

/**
 * A table-cell magnitude bar (DESIGN_GUIDE.md, Data visualization): 6px tall on a `selection`
 * track, filled with the accent. `value` is scaled against `max`; a zero max draws an empty track.
 */
export function InlineBar({ value, max, label }: { value: number; max: number; label: string }) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <Box
      role="img"
      aria-label={label}
      data-testid="admin-inline-bar"
      sx={{ width: 64, height: 6, borderRadius: '3px', bgcolor: 'admin.selection.background', flexShrink: 0 }}
    >
      <Box
        style={{ width: `${value > 0 ? Math.max(percent, 4) : 0}%` }}
        sx={{
          height: '100%',
          borderRadius: '3px',
          bgcolor: 'admin.accent',
        }}
      />
    </Box>
  );
}
