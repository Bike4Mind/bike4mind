import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Box, IconButton, Option, Select, Stack, Typography } from '@mui/joy';
import React from 'react';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  currentLimit: number;
  onLimitChange: (limit: number) => void;
  totalUsers: number;
  pageLimitOptions: number[];
  /** 'full' adds the page-size picker and total count; 'compact' is the pager alone. */
  variant?: 'full' | 'compact';
}

const PaginationControls: React.FC<PaginationControlsProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  currentLimit,
  onLimitChange,
  totalUsers,
  pageLimitOptions,
  variant = 'full',
}) => {
  const isCompact = variant === 'compact';
  // totalPages is 0 until the first response lands; "of 0" would read as an empty result set.
  const pageLabel = totalPages > 0 ? `${currentPage} of ${totalPages}` : `${currentPage}`;
  // A limit persisted under admin-user-tab-01 can outlive a change to the option list. Joy renders
  // an empty button when the value matches no Option (renderValue is never called), so keep the
  // active limit in the list rather than trying to patch the label.
  const limitOptions = pageLimitOptions.includes(currentLimit)
    ? pageLimitOptions
    : [...pageLimitOptions, currentLimit].sort((a, b) => a - b);

  const pager = (
    <Stack direction="row" spacing={0.5} alignItems="center">
      <IconButton
        size="sm"
        variant="outlined"
        color="neutral"
        aria-label="Previous page"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        <ChevronLeftIcon />
      </IconButton>
      <Typography level="body-sm" sx={{ px: 0.5, whiteSpace: 'nowrap' }}>
        {isCompact ? pageLabel : `Page ${pageLabel}`}
      </Typography>
      <IconButton
        size="sm"
        variant="outlined"
        color="neutral"
        aria-label="Next page"
        disabled={currentPage >= totalPages || totalPages === 0}
        onClick={() => onPageChange(currentPage + 1)}
      >
        <ChevronRightIcon />
      </IconButton>
    </Stack>
  );

  const pageSizeSelect = (
    <Select
      // Suffixed per variant: both pagers mount together on desktop, so a shared testid would
      // resolve to two elements and trip Playwright's strict mode.
      data-testid={`admin-page-size-select-${variant}`}
      size="sm"
      value={currentLimit}
      onChange={(_, value) => {
        if (value) onLimitChange(value);
      }}
      sx={{ minWidth: 104 }}
      renderValue={option => <Box component="span">{option?.value ?? currentLimit} / page</Box>}
      slotProps={{ listbox: { placement: isCompact ? 'top' : 'bottom' } }}
    >
      {limitOptions.map(limit => (
        <Option key={limit} value={limit}>
          {limit} / page
        </Option>
      ))}
    </Select>
  );

  // Both variants keep the same geometry - pager left, page size right - so the top and
  // bottom bars line up. Compact only drops the total count and shortens the page label.
  return (
    <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" width="100%" sx={{ my: 1 }}>
      {pager}
      <Stack direction="row" spacing={1} alignItems="center">
        {pageSizeSelect}
        {!isCompact && (
          <Typography level="body-sm" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {totalUsers} users
          </Typography>
        )}
      </Stack>
    </Stack>
  );
};

export default PaginationControls;
