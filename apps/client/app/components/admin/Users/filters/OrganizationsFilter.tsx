import { Box, Checkbox, Dropdown, Menu, MenuButton, MenuItem } from '@mui/joy';
import CorporateFareIcon from '@mui/icons-material/CorporateFare';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUsersTab } from '../useUsersTabParams';

interface OrganizationsFilterProps {
  disabled?: boolean;
  /** Stretch to the container width (mobile drawer) instead of a fixed desktop width. */
  fullWidth?: boolean;
}

const OrganizationsFilter: React.FC<OrganizationsFilterProps> = ({ disabled, fullWidth }) => {
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));
  const organizations = useGetAllOrganizations({ filters: { personal: false } });

  const selected = params.orgSearch || [];

  const displayLabel = (() => {
    if (selected.length === 0 || selected.includes('all')) return 'All Organizations';
    if (selected.length === 1) return selected[0];
    return `${selected.length} Selected`;
  })();

  const toggleOrganization = (orgName: string) => {
    if (orgName === 'all') {
      // "All" only ever selects: an empty orgSearch is reset straight back to ['all'] by the
      // effect in ../index.tsx, so an un-toggle branch here would be dead code. Keep the two in
      // sync if that reset ever changes.
      setParams({ orgSearch: ['all'], page: 1 });
      return;
    }

    const withoutAll = selected.filter(org => org !== 'all');
    const next = selected.includes(orgName) ? withoutAll.filter(org => org !== orgName) : [...withoutAll, orgName];
    setParams({ orgSearch: next, page: 1 });
  };

  return (
    <Dropdown>
      <MenuButton
        data-testid="admin-org-filter-btn"
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={disabled}
        startDecorator={<CorporateFareIcon />}
        endDecorator={<KeyboardArrowDownIcon />}
        sx={{
          width: fullWidth ? '100%' : undefined,
          minWidth: fullWidth ? undefined : 190,
          justifyContent: 'space-between',
          textAlign: 'left',
          fontWeight: 'normal',
        }}
      >
        <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </Box>
      </MenuButton>
      <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 260, zIndex: 1300 }}>
        <MenuItem onClick={() => toggleOrganization('all')}>
          <Checkbox checked={selected.includes('all')} onChange={() => toggleOrganization('all')} sx={{ mr: 1 }} />
          All
        </MenuItem>
        <MenuItem onClick={() => toggleOrganization('Unassigned')}>
          <Checkbox
            checked={selected.includes('Unassigned')}
            onChange={() => toggleOrganization('Unassigned')}
            sx={{ mr: 1 }}
          />
          Unassigned
        </MenuItem>
        {organizations.data?.map(org => (
          <MenuItem key={org.id} onClick={() => toggleOrganization(org.name)}>
            <Checkbox
              checked={selected.includes(org.name)}
              onChange={() => toggleOrganization(org.name)}
              sx={{ mr: 1 }}
            />
            {org.name}
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
};

export default OrganizationsFilter;
