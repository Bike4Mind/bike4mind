/**
 * Filter notebooks by date with preset options. Custom range is not yet wired up.
 */

import { Box, Radio, Typography } from '@mui/joy';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';
import { DateRangePreset } from '@client/app/types/NotebookSearchTypes';
import { green, grayAlpha, brandAlpha } from '@client/app/utils/themes/colors';

type Option = { label: string; value: DateRangePreset | 'allTime' };

const OPTIONS: Option[] = [
  { label: 'All time', value: 'allTime' },
  { label: 'Today', value: 'today' },
  { label: 'Last 7 days', value: 'last7days' },
  { label: 'Last 30 days', value: 'last30days' },
];

interface DateRangePickerProps {
  onClose?: () => void;
}

export default function DateRangePicker({ onClose }: DateRangePickerProps) {
  const filters = useAdvancedSearch(state => state.filters);
  const { setDateRangePreset, clearDateRange } = useAdvancedSearch();

  const currentPreset = filters.dateRange.preset ?? 'allTime';

  const handleSelect = (value: Option['value']) => {
    if (value === 'allTime') {
      clearDateRange();
    } else {
      setDateRangePreset(value as DateRangePreset);
    }
    onClose?.();
  };

  return (
    <Box>
      <Typography sx={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase', color: 'text.tertiary', mb: 2 }}>
        Date Range
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {OPTIONS.map(option => (
          <Box
            key={option.value}
            onClick={() => handleSelect(option.value)}
            sx={theme => ({
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              cursor: 'pointer',
              height: '32px',
              borderRadius: '6px',
              px: 1,
              transition: 'background-color 0.15s ease',
              '&:hover': {
                bgcolor: theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12],
              },
            })}
          >
            <Radio
              checked={currentPreset === option.value}
              onChange={() => handleSelect(option.value)}
              onClick={e => e.stopPropagation()}
              slotProps={{
                radio: {
                  sx: {
                    '&.Mui-checked': {
                      color: green[800],
                      borderColor: green[800],
                    },
                  },
                },
              }}
            />
            <Typography level="body-sm" sx={{ color: 'text.primary' }}>
              {option.label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
