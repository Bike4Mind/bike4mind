import React from 'react';
import { Alert, Box, Typography } from '@mui/joy';
import { capFunctionProblems, type FunctionContractProblem } from '@bike4mind/common';

// Matches the Output tab's error Alert in PythonArtifactViewer.
export const dangerAlertSx = {
  bgcolor: 'danger.700',
  color: 'white',
  '& .MuiTypography-root': { color: 'white' },
} as const;

/** Contract or value problems under a heading, capped like every other problem list. */
const FunctionProblemList = ({ heading, problems }: { heading: string; problems: FunctionContractProblem[] }) => (
  <Alert color="danger" variant="solid" data-testid="python-function-problems" sx={dangerAlertSx}>
    <Box sx={{ minWidth: 0 }}>
      <Typography level="title-sm">{heading}</Typography>
      <Box component="ul" sx={{ my: 0.5, pl: 3 }}>
        {capFunctionProblems(problems).map(problem => (
          <Typography component="li" level="body-sm" key={`${problem.path}:${problem.message}`}>
            {problem.path ? (
              <>
                <code>{problem.path}</code>: {problem.message}
              </>
            ) : (
              problem.message
            )}
          </Typography>
        ))}
      </Box>
    </Box>
  </Alert>
);

export default FunctionProblemList;
