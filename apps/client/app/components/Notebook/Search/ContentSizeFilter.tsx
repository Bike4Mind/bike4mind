/**
 * Radio group to filter notebooks by conversation length (message count).
 */

import { Box, Radio, Typography } from '@mui/joy';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';
import { ContentSize } from '@client/app/types/NotebookSearchTypes';
import { green, grayAlpha, brandAlpha } from '@client/app/utils/themes/colors';

type Option = { label: string; value: ContentSize; range?: string };

const OPTIONS: Option[] = [
  { label: 'Any Size', value: 'any' },
  { label: 'Single Exchange', value: 'single', range: '1' },
  { label: 'Brief', value: 'brief', range: '2-4' },
  { label: 'Short', value: 'short', range: '5-10' },
  { label: 'Medium', value: 'medium', range: '11-20' },
  { label: 'Substantial', value: 'substantial', range: '21-50' },
  { label: 'Deep Dive', value: 'deep', range: '50+' },
];

const radioCheckedSx = {
  '&.Mui-checked': { color: green[800], borderColor: green[800] },
};

export default function ContentSizeFilter() {
  const filters = useAdvancedSearch(state => state.filters);
  const { setContentSize } = useAdvancedSearch();

  return (
    <Box>
      <Typography
        sx={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase', color: 'text.tertiary', mb: 1.5 }}
      >
        Content Size
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {OPTIONS.map(option => (
          <Box
            key={option.value}
            onClick={() => setContentSize(option.value)}
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
              checked={filters.contentSize === option.value}
              onChange={() => setContentSize(option.value)}
              onClick={e => e.stopPropagation()}
              size="sm"
              slotProps={{ radio: { sx: radioCheckedSx } }}
            />
            <Typography level="body-sm" sx={{ color: 'text.primary' }}>
              {option.label}
              {option.range && (
                <Typography component="span" level="body-sm" sx={{ color: 'text.tertiary' }}>
                  {' '}
                  ({option.range})
                </Typography>
              )}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
