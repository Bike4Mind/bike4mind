import React from 'react';
import { Box, Typography } from '@mui/joy';
import { ArtifactLibrary } from '@client/app/components/artifacts/library/ArtifactLibrary';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const ArtifactsPage: React.FC = () => (
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
    data-testid="artifacts-page"
  >
    <Box>
      <Typography level="h2">Artifacts</Typography>
      <Typography level="body-sm" textColor="text.tertiary">
        Everything you have saved as an artifact, from notebooks, projects and the API.
      </Typography>
    </Box>
    <ArtifactLibrary />
  </Box>
);

export default ArtifactsPage;
