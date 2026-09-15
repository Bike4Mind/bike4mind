import React from 'react';
import { Autocomplete, Tooltip, Stack, ListItem, ListItemButton, ListItemContent, ListItemDecorator } from '@mui/joy';
import BusinessIcon from '@mui/icons-material/Business';
import CheckIcon from '@mui/icons-material/Check';

interface OrganizationSelectorProps {
  organizations: string[];
  multiple?: boolean;
  label?: string;
  value: string[];
  onChange: (orgs: string[]) => void;
  tooltip?: string;
  excludedOrgs?: {
    millionOnMars: boolean;
    unknown: boolean;
    personal: boolean;
  };
}

const ALL_VALUE = 'all';
const ALL_DISPLAY = 'All Organizations';

const EXCLUDED_ORG_DISPLAY_NAMES = {
  millionOnMars: 'Million on Mars',
  unknown: 'Unknown',
  personal: 'Personal',
};

export const OrganizationSelector: React.FC<OrganizationSelectorProps> = ({
  organizations,
  multiple = false,
  label = 'Organization',
  value,
  onChange,
  excludedOrgs,
  tooltip = `Select ${multiple ? 'organizations' : 'an organization'}`,
}) => {
  // Map internal "all" value to display "All Organizations" for the UI
  const displayValue = React.useMemo(() => {
    return (value || []).map(val => (val === ALL_VALUE ? ALL_DISPLAY : val));
  }, [value]);

  const effectiveOptions = React.useMemo(() => {
    // Remove any existing "All Organizations" to avoid duplicates
    const filteredOrgs = organizations.filter(org => org !== ALL_DISPLAY);

    // Add excluded orgs that are unchecked to the options
    if (excludedOrgs && value?.includes(ALL_VALUE)) {
      Object.entries(excludedOrgs).forEach(([key, isExcluded]) => {
        if (!isExcluded) {
          const displayName = EXCLUDED_ORG_DISPLAY_NAMES[key as keyof typeof EXCLUDED_ORG_DISPLAY_NAMES];
          if (displayName && !filteredOrgs.includes(displayName)) {
            filteredOrgs.push(displayName);
          }
        }
      });
    }

    // Always include "All Organizations" as an option if "all" is in the value
    if (value?.includes(ALL_VALUE) || organizations.includes(ALL_DISPLAY)) {
      return [ALL_DISPLAY, ...filteredOrgs];
    }

    return filteredOrgs;
  }, [organizations, value, excludedOrgs]);

  const handleOrganizationSelectChange = (selectedValues: string[]) => {
    // Convert "All Organizations" display value back to "all" internal value
    const internalValues = selectedValues.map(val => (val === ALL_DISPLAY ? ALL_VALUE : val));

    if (internalValues.length === 0) {
      onChange([ALL_VALUE]);
    } else {
      // If it previously contained 'all', remove it
      if (internalValues.includes(ALL_VALUE)) {
        onChange(internalValues.filter(val => val !== ALL_VALUE));
      } else {
        onChange(internalValues);
      }
    }
  };

  return (
    <Tooltip title={tooltip}>
      <Stack direction="row" spacing={2} alignItems="center">
        <BusinessIcon />
        <Autocomplete<string, true, undefined, true>
          multiple
          options={effectiveOptions}
          value={displayValue}
          autoComplete={true}
          isOptionEqualToValue={(option, val) => option === val}
          onChange={(event, newValue) => {
            handleOrganizationSelectChange(newValue);
          }}
          slotProps={{
            root: {
              sx: { minWidth: 220 },
            },
            listbox: {
              component: 'ul',
              sx: {
                maxHeight: 200,
                overflowY: 'auto',
              },
            },
          }}
          renderOption={(props, option, state) => {
            // Check if this option is selected (accounting for all/All Organizations mapping)
            const isSelected = option === ALL_DISPLAY ? value?.includes(ALL_VALUE) : value?.includes(option);

            return (
              <ListItem key={option} component="li" {...props}>
                <ListItemButton selected={isSelected}>
                  {isSelected && (
                    <ListItemDecorator>
                      <CheckIcon />
                    </ListItemDecorator>
                  )}
                  <ListItemContent>{option}</ListItemContent>
                </ListItemButton>
              </ListItem>
            );
          }}
        />
      </Stack>
    </Tooltip>
  );
};
