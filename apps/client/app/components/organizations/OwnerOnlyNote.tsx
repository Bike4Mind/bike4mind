import { Alert, Typography } from '@mui/joy';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { FC, ReactNode } from 'react';

interface OwnerOnlyNoteProps {
  /** What only the owner can do, as a sentence fragment: "Changing the plan and seats". */
  children: ReactNode;
  testId: string;
}

/**
 * Stands in for an owner-only control a manager cannot use, so the section explains itself instead of
 * rendering nothing or offering an action that would fail.
 */
const OwnerOnlyNote: FC<OwnerOnlyNoteProps> = ({ children, testId }) => (
  <Alert variant="soft" color="neutral" startDecorator={<LockOutlinedIcon />} data-testid={testId}>
    <Typography level="body-sm">
      <Typography fontWeight="lg">Owner only:</Typography> {children}. Ask the team owner; the Members tab shows who
      that is.
    </Typography>
  </Alert>
);

export default OwnerOnlyNote;
