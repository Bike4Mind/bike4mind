import { Box, Button, Sheet, Stack, Typography } from '@mui/joy';
import { FC } from 'react';

/**
 * Caption for a by-tag table whose rows are a top-N cut. `live` is the counts panel, where a
 * shorter window reaches the rest; `stored` is a written summary's frozen counts, where nothing can.
 * The drill-down cannot filter by tag, so neither wording promises a tag filter.
 */
export const tagTruncationCaption = (shown: number, variant: 'live' | 'stored'): string =>
  variant === 'live'
    ? `Showing the top ${shown} tags by count; narrow the window to see the rest.`
    : `Showing the top ${shown} tags by count; the rest were not included in this summary.`;

/**
 * A grouping's rows. `onSelect` is what makes a count drillable; only the groupings the list route
 * can actually filter by get one, because a cell that opened an unfiltered list would be lying
 * about which rows are behind it.
 */
const FeedbackCountTable: FC<{
  title: string;
  testId: string;
  rows: { key: string; count: number }[];
  caption?: string;
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
}> = ({ title, testId, rows, caption, onSelect, selectedKey }) => (
  <Sheet variant="soft" sx={{ p: 2, borderRadius: 'sm', minWidth: 220, flex: 1 }} data-testid={testId}>
    <Typography level="title-sm" sx={{ mb: 1 }}>
      {title}
    </Typography>
    {rows.length === 0 ? (
      <Typography level="body-sm">None</Typography>
    ) : (
      <Stack spacing={0.5}>
        {rows.map(row =>
          onSelect ? (
            <Button
              key={row.key}
              variant={selectedKey === row.key ? 'soft' : 'plain'}
              size="sm"
              data-testid={`${testId}-row-${row.key}`}
              onClick={() => onSelect(row.key)}
              sx={{ justifyContent: 'space-between', gap: 2, fontWeight: 'normal' }}
            >
              <Typography level="body-sm">{row.key}</Typography>
              <Typography level="body-sm">{row.count}</Typography>
            </Button>
          ) : (
            <Box key={row.key} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
              <Typography level="body-sm">{row.key}</Typography>
              <Typography level="body-sm">{row.count}</Typography>
            </Box>
          )
        )}
      </Stack>
    )}
    {caption && (
      <Typography level="body-xs" textColor="text.tertiary" sx={{ mt: 1 }} data-testid={`${testId}-caption`}>
        {caption}
      </Typography>
    )}
  </Sheet>
);

export default FeedbackCountTable;
