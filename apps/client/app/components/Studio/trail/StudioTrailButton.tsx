import { useState } from 'react';
import { IconButton } from '@mui/joy';
import TimelineIcon from '@mui/icons-material/Timeline';
import type { StudioTrailRestore } from './StudioTrail';
import StudioTrailDialog from './StudioTrailDialog';

type StudioTrailButtonProps = {
  fileId: string;
  testId: string;
  onRestore: StudioTrailRestore;
};

/** A take's trail button and dialog, the same one ImageJobCard shows, for the other media's Create v2 cards. */
const StudioTrailButton = ({ fileId, testId, onRestore }: StudioTrailButtonProps) => {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <IconButton
        size="sm"
        variant="plain"
        aria-label="Show trail"
        data-testid={testId}
        onClick={() => setIsOpen(true)}
      >
        <TimelineIcon />
      </IconButton>
      <StudioTrailDialog fileId={fileId} open={isOpen} onClose={() => setIsOpen(false)} onRestore={onRestore} />
    </>
  );
};

export default StudioTrailButton;
