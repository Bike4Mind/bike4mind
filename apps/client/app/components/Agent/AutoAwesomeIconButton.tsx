import React from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { AutoAwesomeIconButtonProps } from '../../types/agentForm';

const AutoAwesomeIconButton: React.FC<AutoAwesomeIconButtonProps> = ({
  onClick,
  sx,
  loading,
  disabled,
  tooltip,
  ...props
}) => {
  const button = (
    <IconButton
      variant={loading ? 'plain' : 'outlined'}
      color="neutral"
      size="sm"
      onClick={onClick}
      loading={loading}
      disabled={disabled || loading}
      sx={{
        width: 24,
        height: 24,
        minWidth: 24,
        minHeight: 24,
        borderRadius: '4px',
        ...sx,
      }}
      {...props}
    >
      <AutoAwesomeIcon sx={{ fontSize: 12 }} />
    </IconButton>
  );

  if (tooltip) {
    return (
      <Tooltip title={tooltip} placement="top">
        {button}
      </Tooltip>
    );
  }

  return button;
};

export default AutoAwesomeIconButton;
