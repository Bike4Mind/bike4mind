import { Box, Typography, Skeleton } from '@mui/joy';
import { usePopularTargets } from './hooks';
import { green } from '../../../utils/themes/colors';

const Header = () => {
  const { state } = usePopularTargets();
  const accent = state.categoryAccentColor || green[400];

  return (
    <Box sx={{ textAlign: 'center', mb: 2 }}>
      {state.categoryLoading ? (
        <Skeleton variant="rectangular" width={220} height={40} sx={{ mx: 'auto', borderRadius: '12px' }} />
      ) : (
        <>
          <Typography
            level="h4"
            sx={{
              background: `linear-gradient(135deg, ${accent} 0%, ${green[650]} 100%)`,
              border: 'none',
              color: accent,
              backgroundClip: 'text',
              WebkitBackgroundClip: 'text',
              fontWeight: 700,
              letterSpacing: '-0.025em',
              mb: 0.5,
              transition: 'all 0.5s ease',
            }}
          >
            {state.categoryName}
          </Typography>
          <Typography level="body-sm" color="neutral" sx={{ maxWidth: 600, mx: 'auto', fontWeight: 500 }}>
            {state.categoryDescription} • <strong>{state.sources} sources</strong> •{' '}
            <strong>{state.total} total</strong>
          </Typography>
        </>
      )}
    </Box>
  );
};

export default Header;
