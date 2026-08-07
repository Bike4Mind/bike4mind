import React, { useState, useEffect } from 'react';
import {
  Card,
  Stack,
  Typography,
  Button,
  FormControl,
  FormHelperText,
  Input,
  IconButton,
  Box,
  Select,
  Option,
  Chip,
} from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import { METADATA_FIELD, METADATA_OPERATORS } from '@server/analytics/metadataFilterContract';
import type { MetadataFilter } from '../types';
import AddIcon from '@mui/icons-material/Add';

// Shared with the store and the server-side matcher; not redeclared here.
export type { MetadataFilter } from '../types';

/** A blank field is unfinished, not invalid - buildUserActivityRequest drops it before it reaches the server. */
const isFieldValid = (field: string) => field.trim() === '' || METADATA_FIELD.test(field.trim());
/** Unlike isFieldValid, blank is not applicable: a blank-field filter matches nothing and should not gate Apply or render as an active chip. */
const isFieldApplicable = (field: string) => METADATA_FIELD.test(field.trim());
const FIELD_ERROR_MESSAGE = 'Field must start with a letter and may use letters, digits, _, - and up to 4 dots.';

interface FilterRowProps {
  filter: MetadataFilter;
  onChange: (filter: MetadataFilter) => void;
  onDelete: () => void;
  metadataFields: string[];
}

interface MetadataFilterState {
  filters: MetadataFilter[];
  isDirty: boolean;
}

const FilterRow: React.FC<FilterRowProps> = ({ filter, onChange, onDelete, metadataFields }) => {
  const [isCustomField, setIsCustomField] = useState(
    filter.field === 'custom' || !metadataFields.includes(filter.field)
  );
  const [customField, setCustomField] = useState(filter.field === 'custom' ? '' : filter.field);

  const handleFieldChange = (value: string) => {
    if (value === 'custom') {
      setIsCustomField(true);
      onChange({ ...filter, field: '' });
    } else {
      setIsCustomField(false);
      onChange({ ...filter, field: value });
    }
  };

  const handleCustomFieldChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCustomField(value);
    onChange({ ...filter, field: value });
  };

  const fieldIsValid = isFieldValid(filter.field);

  return (
    <Stack spacing={1}>
      {/* Field + operator row */}
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="sm" error={!isCustomField && !fieldIsValid} sx={{ flex: 1 }}>
          <Select
            value={isCustomField ? 'custom' : filter.field}
            onChange={(_, value) => handleFieldChange(value as string)}
          >
            {metadataFields.map(field => (
              <Option key={field} value={field}>
                {field}
              </Option>
            ))}
            <Option value="custom">Custom Field</Option>
          </Select>
          {!isCustomField && !fieldIsValid && (
            <FormHelperText data-testid="metadata-filter-field-error">{FIELD_ERROR_MESSAGE}</FormHelperText>
          )}
        </FormControl>
        {isCustomField && (
          <FormControl size="sm" error={!fieldIsValid} sx={{ flex: 1 }}>
            <Input value={customField} onChange={handleCustomFieldChange} placeholder="Enter field name" size="sm" />
            {!fieldIsValid && (
              <FormHelperText data-testid="metadata-filter-field-error">{FIELD_ERROR_MESSAGE}</FormHelperText>
            )}
          </FormControl>
        )}
        <FormControl size="sm" sx={{ flex: 1 }}>
          <Select<MetadataFilter['operator']>
            value={filter.operator}
            onChange={(_, value) => value && onChange({ ...filter, operator: value })}
          >
            {METADATA_OPERATORS.map(({ value, label }) => (
              <Option key={value} value={value}>
                {label}
              </Option>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {filter.operator === 'contains' && (
        <Typography level="body-xs" color="neutral" data-testid="metadata-filter-contains-hint">
          Contains matches text values only. Use Equals to match a number.
        </Typography>
      )}

      {/* Value + delete row */}
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="sm" sx={{ flex: 1 }}>
          <Input
            value={String(filter.value ?? '')}
            onChange={e => onChange({ ...filter, value: e.target.value })}
            placeholder="Filter value"
            disabled={filter.operator === 'exists' || filter.operator === 'not_exists'}
          />
        </FormControl>
        <IconButton size="sm" color="neutral" onClick={onDelete}>
          <DeleteIcon />
        </IconButton>
      </Stack>
    </Stack>
  );
};

interface MetadataFilterPanelProps {
  onApplyFilters: (filters: MetadataFilter[]) => void;
  initialFilters?: MetadataFilter[];
  metadataFields: string[];
}

export const MetadataFilterPanel: React.FC<MetadataFilterPanelProps> = ({
  onApplyFilters,
  initialFilters = [],
  metadataFields = [],
}) => {
  const [filterState, setFilterState] = useState<MetadataFilterState>({
    filters: initialFilters,
    isDirty: false,
  });
  const [tempFilters, setTempFilters] = useState<MetadataFilter[]>(initialFilters);

  useEffect(() => {
    setTempFilters(initialFilters);
    setFilterState(prev => ({ ...prev, filters: initialFilters }));
  }, [initialFilters]);

  const addNewFilter = () => {
    setTempFilters([
      ...tempFilters,
      {
        field: metadataFields[0] || '',
        operator: 'equals',
        value: '',
      },
    ]);
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const removeFilter = (index: number) => {
    const newFilters = tempFilters.filter((_, i) => i !== index);
    setTempFilters(newFilters);
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const updateFilter = (index: number, updatedFilter: MetadataFilter) => {
    setTempFilters(filters => filters.map((filter, i) => (i === index ? updatedFilter : filter)));
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const handleReset = () => {
    setTempFilters(filterState.filters);
    setFilterState(prev => ({ ...prev, isDirty: false }));
  };

  const handleApply = () => {
    setFilterState({
      filters: tempFilters,
      isDirty: false,
    });
    onApplyFilters(tempFilters);
  };

  const hasInvalidField = tempFilters.some(filter => !isFieldValid(filter.field));
  const hasBlankField = tempFilters.some(filter => filter.field.trim() === '');

  return (
    <Card variant="outlined" sx={{ p: 2, mb: 2 }}>
      <Stack spacing={2}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography level="body-sm" fontWeight={800}>
            Metadata Filters
          </Typography>
          <Button size="sm" startDecorator={<AddIcon />} onClick={addNewFilter}>
            Add Filter
          </Button>
        </Stack>

        {tempFilters.map((filter, index) => (
          <FilterRow
            key={index}
            filter={filter}
            onDelete={() => removeFilter(index)}
            onChange={updatedFilter => updateFilter(index, updatedFilter)}
            metadataFields={metadataFields}
          />
        ))}

        <Stack direction="row" spacing={2} justifyContent="flex-end" alignItems="center">
          {hasInvalidField && (
            <Typography level="body-xs" color="danger" data-testid="metadata-filter-apply-blocked">
              Fix the highlighted field name to apply.
            </Typography>
          )}
          <Button variant="outlined" color="neutral" onClick={handleReset} disabled={!filterState.isDirty}>
            Reset
          </Button>
          <Button onClick={handleApply} disabled={!filterState.isDirty || hasInvalidField || hasBlankField}>
            Apply Filters
          </Button>
        </Stack>

        {filterState.filters.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography level="body-sm" sx={{ mb: 1 }}>
              Active Filters:
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {filterState.filters
                .filter(filter => isFieldApplicable(filter.field))
                .map((filter, index) => (
                  <Chip key={index} variant="soft" color="primary" component="div">
                    {`${filter.field} ${filter.operator} ${filter.value || 'any'}`}
                  </Chip>
                ))}
            </Stack>
          </Box>
        )}
      </Stack>
    </Card>
  );
};
