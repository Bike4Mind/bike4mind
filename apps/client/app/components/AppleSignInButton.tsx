import React from 'react';
import { Button, Typography } from '@mui/joy';
import AppleIcon from '@mui/icons-material/Apple';

interface AppleSignInButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  'data-testid': string;
}

/** Apple's identity guidelines: a black button with white text (inverted in dark mode) and Apple's label. */
const AppleSignInButton: React.FC<AppleSignInButtonProps> = ({ label, onClick, disabled, 'data-testid': testId }) => (
  <Button
    className="apple-login-button"
    data-testid={testId}
    type="button"
    variant="solid"
    fullWidth
    sx={{
      mt: '8px',
      minHeight: '40px',
      borderRadius: '8px',
      gap: '.4rem',
      color: '#fff',
      backgroundColor: '#000',
      '&:hover': { backgroundColor: '#1a1a1a' },
      '[data-joy-color-scheme="dark"] &': {
        color: '#000',
        backgroundColor: '#fff',
        '&:hover': { backgroundColor: '#e6e6e6' },
      },
    }}
    disabled={disabled}
    onClick={onClick}
  >
    <AppleIcon sx={{ width: '18px', height: '18px' }} />
    <Typography sx={{ color: 'inherit', fontWeight: '500', fontSize: '14px' }}>{label}</Typography>
  </Button>
);

export default AppleSignInButton;
