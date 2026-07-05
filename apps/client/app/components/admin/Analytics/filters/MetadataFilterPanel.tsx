import React, { useState, useEffect } from 'react';
import { Card, Stack, Typography, Button, FormControl, Input, IconButton, Box, Select, Option, Chip } from '@mui/joy';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';

export interface MetadataFilter {
  field: string;
  operator: 'equals' | 'contains' | 'in' | 'exists' | 'not_exists';
  value: any;
}

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

  return (
    <Stack spacing={1}>
      {/* Field + operator row */}
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="sm" sx={{ flex: 1 }}>
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
        </FormControl>
        {isCustomField && (
          <FormControl size="sm" sx={{ flex: 1 }}>
            <Input value={customField} onChange={handleCustomFieldChange} placeholder="Enter field name" size="sm" />
          </FormControl>
        )}
        <FormControl size="sm" sx={{ flex: 1 }}>
          <Select
            value={filter.operator}
            onChange={(_, value) => onChange({ ...filter, operator: value as MetadataFilter['operator'] })}
          >
            <Option value="equals">Equals</Option>
            <Option value="contains">Contains</Option>
            <Option value="in">In</Option>
            <Option value="exists">Exists</Option>
            <Option value="not_exists">Does Not Exist</Option>
          </Select>
        </FormControl>
      </Stack>

      {/* Value + delete row */}
      <Stack direction="row" spacing={1} alignItems="center">
        <FormControl size="sm" sx={{ flex: 1 }}>
          <Input
            value={filter.value}
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

        <Stack direction="row" spacing={2} justifyContent="flex-end">
          <Button variant="outlined" color="neutral" onClick={handleReset} disabled={!filterState.isDirty}>
            Reset
          </Button>
          <Button onClick={handleApply} disabled={!filterState.isDirty}>
            Apply Filters
          </Button>
        </Stack>

        {filterState.filters.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography level="body-sm" sx={{ mb: 1 }}>
              Active Filters:
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap">
              {filterState.filters.map((filter, index) => (
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
