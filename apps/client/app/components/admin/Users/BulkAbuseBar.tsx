import GppBadIcon from '@mui/icons-material/GppBad';
import { Button, Stack, Typography } from '@mui/joy';
import React from 'react';

type BulkAbuseBarProps = {
  selectedCount: number;
  onClearSelection: () => void;
  onOpen: () => void;
};

/** Entry point for the bulk abuse response: acts on the selected rows, or on an email domain. */
const BulkAbuseBar: React.FC<BulkAbuseBarProps> = ({ selectedCount, onClearSelection, onOpen }) => (
  <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end" data-testid="bulk-abuse-bar">
    {selectedCount > 0 && (
      <>
        <Typography level="body-sm" data-testid="bulk-abuse-selected-count">
          {selectedCount} selected
        </Typography>
        <Button size="sm" variant="plain" color="neutral" onClick={onClearSelection} data-testid="bulk-abuse-clear-btn">
          Clear
        </Button>
      </>
    )}
    <Button
      size="sm"
      variant="outlined"
      color="danger"
      startDecorator={<GppBadIcon />}
      onClick={onOpen}
      data-testid="bulk-abuse-open-btn"
    >
      Bulk abuse response
    </Button>
  </Stack>
);

export default BulkAbuseBar;
