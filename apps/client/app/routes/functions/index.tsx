import React from 'react';
import { Box, Typography } from '@mui/joy';
import { FunctionLibrary } from '@client/app/components/functions/library/FunctionLibrary';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const FunctionsPage: React.FC = () => (
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
    data-testid="functions-page"
  >
    <Box>
      <Typography level="h2">Functions</Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        The functions you made and the ones shared with you.
      </Typography>
    </Box>
    <FunctionLibrary />
  </Box>
);

export default FunctionsPage;
