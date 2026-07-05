import { useGetUsers } from '@client/app/hooks/data/user';
import { IUserDocument } from '@bike4mind/common';
import {
  Autocomplete,
  AutocompleteOption,
  CircularProgress,
  FormControl,
  FormLabel,
  ListItemContent,
  Typography,
} from '@mui/joy';
import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

interface UserSelectorProps {
  label: string;
  value: string | null;
  onChange: (userId: string | null) => void;
  placeholder?: string;
  required?: boolean;
  helperText?: string;
  excludeUserId?: string; // Optionally exclude a user from results
}

const UserSelector: React.FC<UserSelectorProps> = ({
  label,
  value,
  onChange,
  placeholder = 'Search for a user...',
  required = false,
  helperText,
  excludeUserId,
}) => {
  const { value: inputValue, debouncedValue: debouncedSearch, setValue: setInputValue } = useDebounceValue('');
  const [selectedUserCache, setSelectedUserCache] = useState<IUserDocument | null>(null);

  // Fetch users with debounced search
  const { data, isLoading } = useGetUsers({
    search: debouncedSearch,
    page: 1,
    limit: 20,
    sortField: 'name',
    sortOrder: 'asc',
  });

  const users = useMemo(() => {
    const allUsers = data?.users ?? [];
    return excludeUserId ? allUsers.filter(u => u.id !== excludeUserId) : allUsers;
  }, [data?.users, excludeUserId]);

  // Find selected user from the list or use cached value
  const selectedUser = useMemo(() => {
    if (!value) return null;
    // Try to find in current results first
    const userInResults = users.find(u => u.id === value);
    if (userInResults) return userInResults;
    // If not in current results but we have a cached value with matching ID, use it
    if (selectedUserCache && selectedUserCache.id === value) return selectedUserCache;
    return null;
  }, [users, value, selectedUserCache]);

  // Cache the selected user when it changes
  useEffect(() => {
    if (selectedUser && selectedUser.id === value) {
      setSelectedUserCache(selectedUser);
    }
  }, [selectedUser, value]);

  const handleChange = useCallback(
    (_event: React.SyntheticEvent, newValue: IUserDocument | null) => {
      onChange(newValue?.id || null);
      if (newValue) {
        setSelectedUserCache(newValue);
      }
    },
    [onChange]
  );

  const handleInputChange = useCallback(
    (_event: React.SyntheticEvent, newInputValue: string) => {
      setInputValue(newInputValue);
    },
    [setInputValue]
  );

  return (
    <FormControl required={required}>
      <FormLabel>{label}</FormLabel>
      <Autocomplete
        data-testid="user-selector-autocomplete"
        placeholder={placeholder}
        value={selectedUser}
        onChange={handleChange}
        inputValue={inputValue}
        onInputChange={handleInputChange}
        options={users}
        getOptionLabel={option => option.name || option.username || option.email || 'Unknown User'}
        loading={isLoading}
        endDecorator={isLoading ? <CircularProgress size="sm" sx={{ bgcolor: 'background.surface' }} /> : null}
        renderOption={(props, option) => (
          <AutocompleteOption {...props} data-testid={`user-option-${option.id}`}>
            <ListItemContent>
              <Typography level="body-md">{option.name}</Typography>
              <Typography level="body-sm" color="neutral">
                @{option.username} • {option.email}
              </Typography>
            </ListItemContent>
          </AutocompleteOption>
        )}
      />
      {helperText && (
        <Typography level="body-sm" color="neutral" sx={{ mt: 0.5 }}>
          {helperText}
        </Typography>
      )}
    </FormControl>
  );
};

export default UserSelector;
