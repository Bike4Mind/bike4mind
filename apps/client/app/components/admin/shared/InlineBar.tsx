import { Box } from '@mui/joy';

/** A 56 px track with a 6 px accent bar: a number's share of the largest in view. Decorative. */
export function InlineBar({ value, max }: { value: number; max: number }) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <Box
      aria-hidden
      data-testid="admin-inline-bar"
      sx={{ width: 56, height: 6, borderRadius: '3px', bgcolor: 'admin.hover', overflow: 'hidden', flexShrink: 0 }}
    >
      <Box sx={{ width: `${share * 100}%`, height: '100%', borderRadius: '3px', bgcolor: 'admin.accent' }} />
    </Box>
  );
}
