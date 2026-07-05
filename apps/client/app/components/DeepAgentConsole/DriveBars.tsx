import { FC } from 'react';
import { Box, LinearProgress, Stack, Typography } from '@mui/joy';
import type { Charter } from '@bike4mind/agents';

const DRIVE_LABELS: Record<keyof Charter['drives'], string> = {
  curiosity: 'Curiosity',
  progress: 'Progress',
  social: 'Social',
  novelty: 'Novelty',
  caution: 'Caution',
  aesthetic: 'Aesthetic',
};

/** The agent's motivational state as labeled bars - the "Sims needs" panel. */
const DriveBars: FC<{ drives: Charter['drives'] }> = ({ drives }) => (
  <Stack spacing={0.5} data-testid="deep-agent-drive-bars">
    {(Object.keys(DRIVE_LABELS) as Array<keyof Charter['drives']>).map(key => (
      <Box key={key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography level="body-xs" sx={{ width: 64, color: 'text.tertiary' }}>
          {DRIVE_LABELS[key]}
        </Typography>
        <LinearProgress
          determinate
          value={drives[key] * 100}
          sx={{ flex: 1 }}
          color={key === 'caution' ? 'warning' : 'primary'}
        />
        <Typography level="body-xs" sx={{ width: 32, textAlign: 'right' }}>
          {drives[key].toFixed(2)}
        </Typography>
      </Box>
    ))}
  </Stack>
);

export default DriveBars;
