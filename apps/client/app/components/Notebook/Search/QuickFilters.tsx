/**
 * Boolean toggle filters (favorites, has-summary, has-artifacts, has-files, exclude auto-named).
 */

import { Box, Checkbox, Typography } from '@mui/joy';
import { useAdvancedSearch } from '@client/app/hooks/useAdvancedSearch';
import { green, greenAlpha, grayAlpha, brandAlpha } from '@client/app/utils/themes/colors';

type QuickFilterItem = { label: string; checked: boolean; onChange: () => void };

const checkboxCheckedSx = {
  '&.Mui-checked': {
    border: `1px solid ${green[800]} !important`,
    backgroundColor: `${greenAlpha[800][10]} !important`,
    color: green[800],
    '& svg': { fontSize: '12px' },
  },
};

export default function QuickFilters() {
  const filters = useAdvancedSearch(state => state.filters);
  const { toggleFavoritesOnly, toggleHasSummary, toggleHasArtifacts, toggleHasFiles, toggleExcludeAutoNamed } =
    useAdvancedSearch();

  const items: QuickFilterItem[] = [
    { label: 'Favorites Only', checked: filters.favoritesOnly, onChange: toggleFavoritesOnly },
    { label: 'Has Summary', checked: filters.hasSummary, onChange: toggleHasSummary },
    { label: 'Has Artifacts (Code)', checked: filters.hasArtifacts, onChange: toggleHasArtifacts },
    { label: 'Has Attached Files', checked: filters.hasFiles, onChange: toggleHasFiles },
    { label: 'Exclude Auto-Named Notebooks', checked: filters.excludeAutoNamed, onChange: toggleExcludeAutoNamed },
  ];

  return (
    <Box>
      <Typography
        sx={{ fontSize: '12px', fontWeight: 500, textTransform: 'uppercase', color: 'text.tertiary', mb: 1.5 }}
      >
        Quick Filters
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {items.map(item => (
          <Box
            key={item.label}
            onClick={item.onChange}
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
            <Checkbox
              checked={item.checked}
              onChange={item.onChange}
              onClick={e => e.stopPropagation()}
              size="sm"
              slotProps={{ checkbox: { sx: checkboxCheckedSx } }}
            />
            <Typography level="body-sm" sx={{ color: 'text.primary' }}>
              {item.label}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
