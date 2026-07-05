import React, { useMemo, useState } from 'react';
import { Box, Card, Stack, Typography, Checkbox, Select, Option } from '@mui/joy';
import dayjs from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(isoWeek);

export interface WeekRange {
  start: string;
  end: string;
  weekNumber: number;
  month: string;
}

interface WeekPickerProps {
  selectedWeeks: WeekRange[];
  onWeekSelect: (weeks: WeekRange[]) => void;
  maxWeeks?: number;
}

export const WeekPicker: React.FC<WeekPickerProps> = ({ selectedWeeks, onWeekSelect, maxWeeks = 4 }) => {
  const currentYear = dayjs().year();
  const years = useMemo(() => {
    const yearList = [];
    for (let i = 0; i < 10; i++) {
      yearList.push(currentYear - i);
    }
    return yearList;
  }, [currentYear]);

  const [selectedYear, setSelectedYear] = useState(currentYear);

  // Generate weeks for the selected year
  const weeks = useMemo(() => {
    const weeksList: WeekRange[] = [];
    const startOfYear = dayjs().year(selectedYear).startOf('year');
    const endOfYear = dayjs().year(selectedYear).endOf('year');
    let current = startOfYear.startOf('isoWeek');

    while (current.isBefore(endOfYear)) {
      // Only include weeks up to current week for current year
      if (selectedYear === currentYear && current.isAfter(dayjs())) {
        break;
      }

      const weekStart = current.format('YYYY-MM-DD');
      const weekEnd = current.endOf('isoWeek').format('YYYY-MM-DD');
      weeksList.push({
        start: weekStart,
        end: weekEnd,
        weekNumber: current.isoWeek(),
        month: current.format('MMM'),
      });
      current = current.add(1, 'week');
    }

    // Sort weeks in descending order (most recent first)
    return weeksList.reverse();
  }, [selectedYear, currentYear]);

  const handleWeekToggle = (week: WeekRange) => {
    const isSelected = selectedWeeks.some(selected => selected.start === week.start && selected.end === week.end);

    if (isSelected) {
      onWeekSelect(selectedWeeks.filter(selected => selected.start !== week.start || selected.end !== week.end));
    } else if (selectedWeeks.length < maxWeeks) {
      onWeekSelect([...selectedWeeks, week]);
    }
  };

  return (
    <Box>
      <Stack spacing={1}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography level="title-md" sx={{ flex: 1 }}>
            Select Weeks ({selectedWeeks.length}/{maxWeeks})
          </Typography>
          <Select value={selectedYear} onChange={(_, value) => setSelectedYear(value as number)} sx={{ minWidth: 100 }}>
            {years.map(year => (
              <Option key={year} value={year}>
                {year}
              </Option>
            ))}
          </Select>
        </Stack>

        <Card variant="outlined" sx={{ p: 1, maxHeight: '200px', overflow: 'auto' }}>
          <Stack spacing={1}>
            {weeks.map(week => {
              const isSelected = selectedWeeks.some(
                selected => selected.start === week.start && selected.end === week.end
              );
              const weekStart = dayjs(week.start);
              const weekEnd = dayjs(week.end);

              return (
                <Stack
                  key={week.start}
                  direction="row"
                  spacing={2}
                  alignItems="center"
                  sx={{
                    p: 1,
                    borderRadius: 'sm',
                    '&:hover': { bgcolor: 'background.level1' },
                  }}
                >
                  <Checkbox
                    checked={isSelected}
                    onChange={() => handleWeekToggle(week)}
                    disabled={!isSelected && selectedWeeks.length >= maxWeeks}
                  />
                  <Box>
                    <Typography level="body-sm">
                      Week {week.weekNumber} ({week.month})
                    </Typography>
                    <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                      {weekStart.format('MMM D')} - {weekEnd.format('MMM D, YYYY')}
                    </Typography>
                  </Box>
                </Stack>
              );
            })}
          </Stack>
        </Card>
      </Stack>
    </Box>
  );
};
