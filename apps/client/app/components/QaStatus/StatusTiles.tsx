import { FC } from 'react';
import { Card, Chip, Grid, Typography } from '@mui/joy';
import type { QaTile } from '@client/app/hooks/data/qaStatus';
import { formatTime, stateLabel } from './format';

const COLOR = { passed: 'success', failed: 'danger', 'infra-error': 'warning' } as const;

function describeTile(tile: QaTile): string {
  const since = tile.failingSince ? ` since ${formatTime(tile.failingSince)}` : '';
  if (tile.status === 'infra-error') return `env down${since}`;
  if (tile.status === 'failed') {
    return `failing${since}, ${tile.failedCount} test${tile.failedCount === 1 ? '' : 's'}`;
  }
  return 'passing';
}

const StatusTiles: FC<{ tiles: QaTile[]; onOpenRun: (runId: string) => void }> = ({ tiles, onOpenRun }) => (
  <Grid container spacing={1.5}>
    {tiles.map(tile => (
      <Grid key={`${tile.suite}|${tile.env}|${tile.tenant ?? ''}`} xs={12} sm={6} md={4} lg={3}>
        <Card
          data-testid="qa-tile"
          variant="soft"
          color={COLOR[tile.status]}
          onClick={() => onOpenRun(tile.latestRunId)}
          sx={{ cursor: 'pointer' }}
        >
          <Typography level="title-sm">{stateLabel(tile)}</Typography>
          <Typography level="body-sm">{describeTile(tile)}</Typography>
          {tile.nonPassingRuns > 1 && (
            <Chip size="sm" variant="outlined" color={COLOR[tile.status]}>
              {tile.nonPassingRuns} runs
            </Chip>
          )}
        </Card>
      </Grid>
    ))}
  </Grid>
);

export default StatusTiles;
