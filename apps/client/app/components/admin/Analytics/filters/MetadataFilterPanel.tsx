import React, { useState, useEffect, useRef } from 'react';
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
  // Seeded once per row and changed only by an explicit Select choice, not derived from
  // filter.field on every render - otherwise typing a custom name that happens to match a
  // suggestion (or a page turn that changes `metadataFields`) would swap the Input out from
  // under the cursor mid-entry. Safe now that rows key on a stable id rather than array index.
  const [isCustomField, setIsCustomField] = useState(() => !metadataFields.includes(filter.field));

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
    onChange({ ...filter, field: e.target.value });
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
            <Input value={filter.field} onChange={handleCustomFieldChange} placeholder="Enter field name" size="sm" />
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
        <Typography level="body-xs" color="warning" data-testid="metadata-filter-contains-hint">
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
        <IconButton size="sm" color="neutral" onClick={onDelete} data-testid="metadata-filter-delete-row">
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

  // Rows key on these instead of array index, so deleting a row does not shift a surviving
  // row into another instance's slot and inherit its local isCustomField state. The counter
  // is only ever read/written from effects and event handlers, never during render.
  const nextRowId = useRef(initialFilters.length);
  const [rowIds, setRowIds] = useState<number[]>(() => initialFilters.map((_, i) => i));

  useEffect(() => {
    setTempFilters(initialFilters);
    setFilterState(prev => ({ ...prev, filters: initialFilters }));
    setRowIds(initialFilters.map((_, i) => i));
    nextRowId.current = initialFilters.length;
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
    setRowIds([...rowIds, nextRowId.current++]);
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const removeFilter = (index: number) => {
    setTempFilters(tempFilters.filter((_, i) => i !== index));
    setRowIds(rowIds.filter((_, i) => i !== index));
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const updateFilter = (index: number, updatedFilter: MetadataFilter) => {
    setTempFilters(filters => filters.map((filter, i) => (i === index ? updatedFilter : filter)));
    setFilterState(prev => ({ ...prev, isDirty: true }));
  };

  const handleReset = () => {
    setTempFilters(filterState.filters);
    // tempFilters and rowIds are kept in lockstep by add/remove, but a wholesale replacement
    // here would otherwise leave rowIds at whatever length editing had grown it to.
    setRowIds(filterState.filters.map((_, i) => i));
    nextRowId.current = filterState.filters.length;
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
  const activeFilterChips = filterState.filters.filter(filter => isFieldApplicable(filter.field));

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
            key={rowIds[index]}
            filter={filter}
            onDelete={() => removeFilter(index)}
            onChange={updatedFilter => updateFilter(index, updatedFilter)}
            metadataFields={metadataFields}
          />
        ))}

        <Stack direction="row" spacing={2} justifyContent="flex-end" alignItems="center">
          {(hasInvalidField || hasBlankField) && (
            <Typography level="body-xs" color="danger" data-testid="metadata-filter-apply-blocked">
              {hasInvalidField ? 'Fix the highlighted field name to apply.' : 'Fill in the field name to apply.'}
            </Typography>
          )}
          <Button variant="outlined" color="neutral" onClick={handleReset} disabled={!filterState.isDirty}>
            Reset
          </Button>
          <Button onClick={handleApply} disabled={!filterState.isDirty || hasInvalidField || hasBlankField}>
            Apply Filters
          </Button>
        </Stack>

        {activeFilterChips.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography level="body-sm" sx={{ mb: 1 }}>
              Active Filters:
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {activeFilterChips.map((filter, index) => (
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
