import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { IconButton, Option, Select, Stack, Tooltip } from '@mui/joy';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUsersTab } from '../useUsersTabParams';

interface SortControlsProps {
  disabled?: boolean;
  fullWidth?: boolean;
}

/**
 * Owns the sort testids the admin e2e suite depends on. The order button must keep
 * its `disabled` binding: the suite uses its enabled state as the "fetch finished" probe.
 */
const SortControls: React.FC<SortControlsProps> = ({ disabled, fullWidth }) => {
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));

  const isAscending = params.sortOrder === 'asc';

  return (
    <Stack direction="row" sx={{ width: fullWidth ? '100%' : undefined, flexShrink: 0 }}>
      <Select
        data-testid="admin-sort-by-select"
        slotProps={{ listbox: { 'data-testid': 'admin-sort-by-listbox', sx: { zIndex: 1300 } } }}
        size="sm"
        variant="outlined"
        startDecorator={<SwapVertIcon />}
        value={params.sortField}
        onChange={(_, value) => {
          if (value) setParams({ sortField: value, page: 1 });
        }}
        disabled={disabled}
        sx={{
          flex: fullWidth ? 1 : undefined,
          minWidth: fullWidth ? undefined : 150,
          borderTopRightRadius: 0,
          borderBottomRightRadius: 0,
        }}
      >
        <Option value="createdAt" data-testid="sort-option-created-at">
          Created At
        </Option>
        <Option value="name" data-testid="sort-option-name">
          Name
        </Option>
      </Select>
      <Tooltip title={isAscending ? 'Ascending (A to Z)' : 'Descending (Z to A)'}>
        <IconButton
          data-testid="admin-sort-order-btn"
          aria-label={isAscending ? 'Sort ascending' : 'Sort descending'}
          size="sm"
          variant="outlined"
          color="neutral"
          disabled={disabled}
          onClick={() => setParams({ sortOrder: isAscending ? 'desc' : 'asc', page: 1 })}
          sx={{ ml: '-1px', borderTopLeftRadius: 0, borderBottomLeftRadius: 0, flexShrink: 0 }}
        >
          {isAscending ? <ArrowUpwardIcon /> : <ArrowDownwardIcon />}
        </IconButton>
      </Tooltip>
    </Stack>
  );
};

export default SortControls;
