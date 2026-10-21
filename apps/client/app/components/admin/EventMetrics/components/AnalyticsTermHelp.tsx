import { useState } from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';

type AnalyticsTermHelpProps = {
  term: string;
  description: string;
};

export function AnalyticsTermHelp({ term, description }: AnalyticsTermHelpProps) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      title={description}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      describeChild
      disableTouchListener
      sx={{ maxWidth: 300 }}
    >
      <IconButton
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={`About ${term}`}
        onClick={() => setOpen(true)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        sx={{ verticalAlign: 'middle' }}
      >
        <HelpOutlineIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
