import { useEffect } from 'react';
import { Box, Input, Skeleton } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import { usePopularTargets } from './hooks';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { greenAlpha } from '@client/app/utils/themes/colors';

const Search = () => {
  const { state, setState } = usePopularTargets();
  const { value, setValue, debouncedValue } = useDebounceValue(state.searchTerm, 1000);

  useEffect(() => {
    if (debouncedValue !== state.searchTerm) {
      setState({ searchTerm: debouncedValue });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue]);

  if (state.businessLinksLoading && !state.searchTerm) {
    return null;
  }

  return (
    <Box sx={{ mb: 2, maxWidth: '600px', mx: 'auto' }}>
      {state.categoryLoading ? (
        <Skeleton variant="rectangular" width={350} height={30} sx={{ mx: 'auto', borderRadius: '12px' }} />
      ) : (
        <Input
          placeholder={`Search ${state.categoryName}...`}
          value={value}
          onChange={e => setValue(e.target.value)}
          startDecorator={<SearchIcon />}
          size="lg"
          sx={{
            '--Input-focusedThickness': '2px',
            '--Input-focusedHighlight': greenAlpha[400][40],
            width: '100%',
            borderRadius: '12px',
            transition: 'all 0.3s ease',
            '&:focus-within': {
              boxShadow: `0 0 0 2px ${greenAlpha[400][40]}`,
            },
          }}
        />
      )}
    </Box>
  );
};

export default Search;
