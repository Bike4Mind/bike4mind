import { FC } from 'react';
import { Alert, Stack } from '@mui/joy';
import { WarningAmberRounded } from '@mui/icons-material';

/** Non-fatal notices from the task's latest run; renders nothing when there are none. */
const ResearchTaskDetailWarnings: FC<{ warnings?: string[] }> = ({ warnings }) => {
  if (!warnings?.length) return null;
  return (
    <Stack spacing={1} sx={{ mt: 2 }} data-testid="research-task-warnings">
      {warnings.map((warning, i) => (
        <Alert key={i} color="warning" variant="soft" startDecorator={<WarningAmberRounded />}>
          {warning}
        </Alert>
      ))}
    </Stack>
  );
};

export default ResearchTaskDetailWarnings;
