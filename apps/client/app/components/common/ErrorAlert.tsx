import { Alert, IconButton, Typography } from '@mui/joy';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import CloseIcon from '@mui/icons-material/Close';
import React from 'react';

interface ErrorAlertProps {
  error: string | null;
  level?: 'body-xs' | 'body-sm' | 'body-md' | 'body-lg';
  className?: string;
  sx?: object;
  /** When provided, renders a dismiss button that calls this on click. */
  onClose?: () => void;
}

const ErrorAlert: React.FC<ErrorAlertProps> = ({ error, level = 'body-xs', sx = {}, onClose }) => {
  if (!error) return null;

  return (
    <Alert
      variant="soft"
      color="danger"
      size="sm"
      sx={{
        my: 2,
        alignItems: 'flex-start',
        borderRadius: '8px',
        ...sx,
      }}
      startDecorator={<ErrorOutlineIcon />}
      endDecorator={
        onClose ? (
          <IconButton variant="plain" color="danger" size="sm" onClick={onClose} aria-label="Dismiss error">
            <CloseIcon />
          </IconButton>
        ) : undefined
      }
    >
      <Typography level={level} component="div" color="danger">
        {error}
      </Typography>
    </Alert>
  );
};

export default ErrorAlert;
