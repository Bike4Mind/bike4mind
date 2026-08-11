import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { useGetUserTags } from '@client/app/hooks/data/user';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { Box, Checkbox, Dropdown, Menu, MenuButton, MenuItem } from '@mui/joy';
import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUsersTab } from '../useUsersTabParams';

interface UserTagsFilterProps {
  disabled?: boolean;
  fullWidth?: boolean;
}

const UserTagsFilter: React.FC<UserTagsFilterProps> = ({ disabled, fullWidth }) => {
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));
  const userTags = useGetUserTags();

  const selected = params.tags || [];

  const availableTags = useMemo(
    () => Array.from(new Set(['Admin', ...PREDEFINED_USER_TAGS, ...(userTags.data || [])])),
    [userTags.data]
  );

  const displayLabel = (() => {
    if (selected.length === 0) return 'All Tags';
    if (selected.length === 1) return selected[0];
    return `${selected.length} tags selected`;
  })();

  const toggleTag = (tagName: string) => {
    const next = selected.includes(tagName) ? selected.filter(tag => tag !== tagName) : [...selected, tagName];
    setParams({ tags: next, page: 1 });
  };

  return (
    <Dropdown>
      <MenuButton
        data-testid="admin-tags-filter-btn"
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={disabled}
        startDecorator={<LocalOfferIcon />}
        endDecorator={<KeyboardArrowDownIcon />}
        sx={{
          width: fullWidth ? '100%' : undefined,
          minWidth: fullWidth ? undefined : 160,
          justifyContent: 'space-between',
          textAlign: 'left',
          fontWeight: 'normal',
        }}
      >
        <Box sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayLabel}
        </Box>
      </MenuButton>
      <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 200, zIndex: 1300 }}>
        {availableTags.map(tag => (
          <MenuItem key={tag} onClick={() => toggleTag(tag)}>
            <Checkbox checked={selected.includes(tag)} onChange={() => toggleTag(tag)} sx={{ mr: 1 }} />
            {tag}
          </MenuItem>
        ))}
      </Menu>
    </Dropdown>
  );
};

export default UserTagsFilter;
