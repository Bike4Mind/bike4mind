import { FC } from 'react';
import { Box, Select, Option } from '@mui/joy';
import { ResearchTaskStatus, ResearchTaskType } from '@bike4mind/common';
import { FilterList, Assessment } from '@mui/icons-material';

interface FilterBarProps {
  status: ResearchTaskStatus | null;
  type: ResearchTaskType | null;
  onStatusChange: (value: ResearchTaskStatus | null) => void;
  onTypeChange: (value: ResearchTaskType | null) => void;
}

const FilterBar: FC<FilterBarProps> = ({ status, type, onStatusChange, onTypeChange }) => {
  return (
    <Box sx={{ display: 'flex', gap: 1 }}>
      <Select
        placeholder="Status"
        value={status}
        onChange={(_, value) => onStatusChange(value as ResearchTaskStatus | null)}
        startDecorator={<FilterList />}
        sx={{ minWidth: 140 }}
      >
        <Option value="">All Statuses</Option>
        {Object.values(ResearchTaskStatus).map(status => (
          <Option key={status} value={status}>
            {status}
          </Option>
        ))}
      </Select>
      <Select
        placeholder="Type"
        value={type}
        onChange={(_, value) => onTypeChange(value as ResearchTaskType | null)}
        startDecorator={<Assessment />}
        sx={{ minWidth: 140 }}
      >
        <Option value="">All Types</Option>
        {Object.values(ResearchTaskType).map(type => (
          <Option key={type} value={type}>
            {type}
          </Option>
        ))}
      </Select>
    </Box>
  );
};

export default FilterBar;
