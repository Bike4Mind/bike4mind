import { Typography } from '@mui/joy';

/** The muted em dash for an empty value (DESIGN_GUIDE: empty values are an inkMuted dash). */
export const Dash = ({ title, 'data-testid': testId }: { title?: string; 'data-testid'?: string }) => (
  <Typography
    component="span"
    sx={{ color: 'admin.inkMuted' }}
    aria-label={title ?? 'None'}
    title={title}
    data-testid={testId}
  >
    {'\u2014'}
  </Typography>
);
