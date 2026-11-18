import { Typography } from '@mui/joy';
import type { FieldSaveStatus as Status } from './useFieldAutosave';

const LABEL: Record<Exclude<Status['kind'], 'error'>, string> = {
  saved: 'Saved',
  pending: 'Unsaved changes',
  saving: 'Saving...',
};

/** The quiet save line a planning panel shows beside its heading. */
const FieldSaveStatus = ({ status, testId }: { status: Status; testId: string }) => (
  <Typography
    level="body-xs"
    color={status.kind === 'error' ? 'danger' : 'neutral'}
    data-testid={testId}
    data-status={status.kind}
    sx={{ marginLeft: 'auto' }}
  >
    {status.kind === 'error' ? `Not saved: ${status.message}` : LABEL[status.kind]}
  </Typography>
);

export default FieldSaveStatus;
