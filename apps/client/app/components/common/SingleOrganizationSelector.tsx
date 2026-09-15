import { useGetOrganization } from '@client/app/utils/organizationAPICalls';
import CheckIcon from '@mui/icons-material/Check';
import {
  Autocomplete,
  ListItem,
  ListItemButton,
  ListItemContent,
  ListItemDecorator,
  Tooltip,
  Typography,
} from '@mui/joy';
import { ComponentProps, useEffect, useState } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useSearchUserOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

interface Props {
  size?: ComponentProps<typeof Autocomplete>['size'];
  currentOrgId: string | null;
  onChange: (orgId: string | null) => void;
  loading?: boolean;
  disabled?: boolean;
}

const SingleOrganizationSelector = ({ currentOrgId, size, onChange, loading, disabled }: Props) => {
  const { currentUser } = useUser();
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const { debouncedValue: debouncedSearch, setValue: setSearchInput } = useDebounceValue('', 500);

  // Show all available organizations for the current user (do not filter out personal by default)
  const { data: organizationsData, isLoading } = useSearchUserOrganizations(
    currentUser?.id ?? '',
    debouncedSearch,
    undefined,
    undefined,
    { enabled: !!currentUser?.id }
  );
  const { data: currentOrg } = useGetOrganization(currentOrgId ?? '');

  useEffect(() => {
    setSelectedOrgId(currentOrgId);
  }, [currentOrgId]);

  const organizations = organizationsData?.pages.flatMap(page => page.data) ?? [];

  const filteredOrgs = organizations.sort((a, b) => a.name.localeCompare(b.name));

  const handleOrgChange = (orgId: string | null) => {
    setSelectedOrgId(orgId);
    onChange(orgId);
  };

  return !currentUser?.isAdmin ? (
    <Typography className="organization-selector-current">{currentOrg?.name ?? 'No organization'}</Typography>
  ) : (
    <Tooltip
      title={organizations.find(org => org.id === selectedOrgId)?.name ?? 'Select an organization'}
      className="organization-selector-tooltip"
      arrow
      placement="right"
    >
      <Autocomplete
        className="organization-selector"
        size={size}
        disabled={disabled || loading || isLoading}
        options={filteredOrgs}
        value={filteredOrgs.find(org => org.id === selectedOrgId) ?? null}
        onChange={(_, value) => handleOrgChange(value?.id ?? null)}
        onInputChange={(_, value) => setSearchInput(value ?? '')}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        getOptionLabel={option => option.name}
        slotProps={{
          listbox: {
            sx: {
              maxHeight: 200,
              overflowY: 'auto',
            },
          },
        }}
        renderOption={(props, option) => (
          <ListItem {...props} className="organization-selector-list-item">
            <ListItemButton className="organization-selector-list-item-button">
              {selectedOrgId === option.id && (
                <ListItemDecorator className="organization-selector-list-item-decorator">
                  <CheckIcon />
                </ListItemDecorator>
              )}
              <ListItemContent className="organization-selector-list-item-content">{option.name}</ListItemContent>
            </ListItemButton>
          </ListItem>
        )}
      />
    </Tooltip>
  );
};

export default SingleOrganizationSelector;
