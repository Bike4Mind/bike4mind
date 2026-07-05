/**
 * Total search-result count with a per-type breakdown (Original, Cloned, Forked, Shared).
 */

import { Box, Typography, Chip, Tooltip } from '@mui/joy';
import { SearchResultsMetadata } from '@client/app/types/NotebookSearchTypes';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { Theme } from '@mui/joy/styles';

interface SearchResultsCounterProps {
  metadata: SearchResultsMetadata | null;
  isLoading?: boolean;
  showBreakdown?: boolean;
  compact?: boolean;
}

const breakdownChipSx = (theme: Theme) => ({
  bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
  color: theme.palette.fileBrowser.statusChip.textColor,
  border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
  fontSize: '13px',
  height: '24px',
  gap: '4px',
  px: '8px',
  fontWeight: 500,
});

export default function SearchResultsCounter({
  metadata,
  isLoading = false,
  showBreakdown = true,
  compact = false,
}: SearchResultsCounterProps) {
  if (isLoading) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          py: 1,
        }}
      >
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          Loading results...
        </Typography>
      </Box>
    );
  }

  if (!metadata) {
    return null;
  }

  const { notebooks, breakdown } = metadata;

  if (compact) {
    return (
      <Chip size="sm" variant="soft" color="neutral" startDecorator={<InfoOutlinedIcon sx={{ fontSize: '16px' }} />}>
        {notebooks} {notebooks === 1 ? 'item' : 'items'}
      </Chip>
    );
  }

  if (notebooks === 0) {
    return (
      <Box sx={{ py: 1 }}>
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          No results found
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      data-testid="search-results-counter"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      }}
    >
      {/* Notebook breakdown chips */}
      {showBreakdown && notebooks > 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          {/* Total chip - always first */}
          <Chip size="sm" variant="soft" sx={breakdownChipSx}>
            Total: {notebooks}
          </Chip>
          {breakdown.original > 0 && (
            <Tooltip title="Original notebooks you created" placement="top">
              <Chip size="sm" variant="soft" sx={breakdownChipSx}>
                Original: {breakdown.original}
              </Chip>
            </Tooltip>
          )}

          {breakdown.cloned > 0 && (
            <Tooltip title="Notebooks you cloned from others" placement="top">
              <Chip size="sm" variant="soft" sx={breakdownChipSx}>
                Cloned: {breakdown.cloned}
              </Chip>
            </Tooltip>
          )}

          {breakdown.forked > 0 && (
            <Tooltip title="Notebooks you forked from your own" placement="top">
              <Chip size="sm" variant="soft" sx={breakdownChipSx}>
                Forked: {breakdown.forked}
              </Chip>
            </Tooltip>
          )}

          {breakdown.shared > 0 && (
            <Tooltip title="Notebooks shared with you by others" placement="top">
              <Chip size="sm" variant="soft" sx={breakdownChipSx}>
                Shared: {breakdown.shared}
              </Chip>
            </Tooltip>
          )}
        </Box>
      )}
    </Box>
  );
}
