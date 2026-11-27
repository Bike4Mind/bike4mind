import React from 'react';
import { Link as RouterLink, useParams } from '@tanstack/react-router';
import { Box, Link } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { FunctionDetail } from '@client/app/components/functions/library/FunctionDetail';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

/** One function at `/functions/$id`, opened from the functions library. */
const FunctionPage: React.FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 3,
        gap: 2,
        overflowY: 'auto',
        ...scrollbarStyles,
      }}
      data-testid="function-page"
    >
      <Link
        component={RouterLink}
        to="/functions"
        level="body-sm"
        startDecorator={<ArrowBackIcon fontSize="small" />}
        sx={{ alignSelf: 'flex-start' }}
      >
        All functions
      </Link>
      <FunctionDetail id={id} />
    </Box>
  );
};

export default FunctionPage;
