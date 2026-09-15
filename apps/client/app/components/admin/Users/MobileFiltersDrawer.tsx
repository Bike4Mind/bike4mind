import { Button, DialogContent, DialogTitle, Divider, Drawer, ModalClose, Stack, Typography } from '@mui/joy';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import OrganizationsFilter from './filters/OrganizationsFilter';
import SortControls from './filters/SortControls';
import UserTagsFilter from './filters/UserTagsFilter';
import { CLEARED_FILTER_PARAMS, countActiveFilters, useUsersTab } from './useUsersTabParams';

interface MobileFiltersDrawerProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
}

/**
 * Bottom sheet hosting the org/tag/sort controls on phones. Changes apply live through the
 * shared params store, so "Done" only dismisses the sheet.
 */
const MobileFiltersDrawer: React.FC<MobileFiltersDrawerProps> = ({ open, onClose, loading }) => {
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));
  const activeFilterCount = countActiveFilters(params);

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      data-testid="admin-users-filters-drawer"
      slotProps={{
        content: {
          sx: {
            height: 'auto',
            maxHeight: '80dvh',
            borderTopLeftRadius: 'lg',
            borderTopRightRadius: 'lg',
          },
        },
      }}
    >
      <ModalClose />
      <DialogTitle>Filters</DialogTitle>
      <Divider />
      <DialogContent sx={{ gap: 2, p: 2 }}>
        <Stack spacing={0.5}>
          <Typography level="title-sm">Organizations</Typography>
          <OrganizationsFilter disabled={loading} fullWidth />
        </Stack>
        <Stack spacing={0.5}>
          <Typography level="title-sm">User Tags</Typography>
          <UserTagsFilter disabled={loading} fullWidth />
        </Stack>
        <Stack spacing={0.5}>
          <Typography level="title-sm">Sort</Typography>
          <SortControls disabled={loading} fullWidth />
        </Stack>
      </DialogContent>
      <Divider />
      <Stack direction="row" spacing={1} sx={{ p: 2 }}>
        <Button
          data-testid="admin-users-filters-clear-btn"
          variant="plain"
          color="neutral"
          disabled={activeFilterCount === 0}
          onClick={() => setParams(CLEARED_FILTER_PARAMS)}
          sx={{ flex: 1 }}
        >
          Clear all
        </Button>
        <Button data-testid="admin-users-filters-done-btn" onClick={onClose} sx={{ flex: 1 }}>
          Done
        </Button>
      </Stack>
    </Drawer>
  );
};

export default MobileFiltersDrawer;
