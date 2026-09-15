/**
 * Radio group to filter notebooks by source (all, original, cloned, forked).
 */

import { Box, Radio, Typography } from '@mui/joy';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';
import { SourceType } from '@client/app/types/NotebookSearchTypes';
import { green, grayAlpha, brandAlpha } from '@client/app/utils/themes/colors';

type Option = { label: string; value: SourceType };

const OPTIONS: Option[] = [
  { label: 'All Notebooks', value: 'all' },
  { label: 'Original', value: 'original' },
  { label: 'Cloned', value: 'cloned' },
  { label: 'Forked', value: 'forked' },
];

const radioCheckedSx = {
  '&.Mui-checked': { color: green[800], borderColor: green[800] },
};

export default function SourceTypeFilter() {
  const filters = useAdvancedSearch(state => state.filters);
  const { setSourceType } = useAdvancedSearch();

  return (
    <Box>
      <Typography
        sx={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase', color: 'text.tertiary', mb: 1.5 }}
      >
        Source Type
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {OPTIONS.map(option => (
          <Box
            key={option.value}
            onClick={() => setSourceType(option.value)}
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
              checked={filters.sourceType === option.value}
              onChange={() => setSourceType(option.value)}
              onClick={e => e.stopPropagation()}
              size="sm"
              slotProps={{ radio: { sx: radioCheckedSx } }}
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
