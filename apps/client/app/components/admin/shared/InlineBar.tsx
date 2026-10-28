import { Box } from '@mui/joy';

/**
 * A 56 px track with a 6 px accent bar: a number's share of the largest in view. Decorative, so the
 * number itself stays in the cell. A non-zero value keeps a sliver visible against a much larger max.
 */
export function InlineBar({ value, max }: { value: number; max: number }) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <Box
      aria-hidden
      data-testid="admin-inline-bar"
      sx={{ width: 56, height: 6, borderRadius: '3px', bgcolor: 'admin.hover', overflow: 'hidden', flexShrink: 0 }}
    >
      <Box
        style={{ width: `${value > 0 && percent > 0 ? Math.max(percent, 4) : 0}%` }}
        sx={{ height: '100%', borderRadius: '3px', bgcolor: 'admin.accent' }}
      />
    </Box>
  );
}
