import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { Button, IconButton, Tooltip } from '@mui/joy';
import { FC } from 'react';

type GeneratedFilterToggleProps = {
  active: boolean;
  onChange: (active: boolean) => void;
  /** Icon-only, for the mobile filter row. */
  compact?: boolean;
};

/**
 * Quick filter for files made by a generation tool. Sets `filters.generated`, which the server ANDs with the
 * selected tags (they match any of their names), so turning it on always narrows the list.
 */
export const GeneratedFilterToggle: FC<GeneratedFilterToggleProps> = ({ active, onChange, compact = false }) => {
  const shared = {
    onClick: () => onChange(!active),
    'aria-pressed': active,
    variant: active ? 'solid' : 'outlined',
    color: active ? 'primary' : 'neutral',
    'data-testid': 'file-browser-generated-filter-btn',
  } as const;

  if (compact) {
    return (
      <Tooltip title="Generated">
        <IconButton {...shared} size="sm" aria-label="Generated">
          <AutoAwesomeIcon />
        </IconButton>
      </Tooltip>
    );
  }
  return (
    <Button {...shared} size="sm" startDecorator={<AutoAwesomeIcon />} sx={{ height: 32, borderRadius: '6px' }}>
      Generated
    </Button>
  );
};

export default GeneratedFilterToggle;
