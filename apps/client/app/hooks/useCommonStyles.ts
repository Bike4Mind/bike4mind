import { SxProps } from '@mui/joy/styles/types';
import { alpha } from '@mui/system';

export const useCommonStyles = () => {
  const inputStyles: SxProps = {
    width: '100%',
    overflow: 'hidden',
    backgroundColor: theme => theme.palette.loginRegister.inputFieldBg,
    boxShadow: 'none',
    borderRadius: '8px',
    '& input': {
      backgroundColor: 'transparent',
      color: 'text.primary',
      fontSize: '16px',
    },
    '& input::placeholder': {
      color: 'text.tertiary',
      opacity: 1,
    },
    '&:-webkit-autofill, & input:-webkit-autofill': {
      WebkitBackgroundClip: 'text',
      backgroundColor: 'transparent',
      borderRadius: '8px',
    },
  };

  const dividerStyles: SxProps = {
    '--Divider-lineColor': theme => alpha(theme.palette.text.primary, 0.2),
    my: '20px',
    '&::before, &::after': {
      borderColor: theme => alpha(theme.palette.text.primary, 0.2),
    },
    color: 'text.tertiary',
  };

  const visibilityToggleStyles: SxProps = {
    minWidth: 'unset',
    padding: '0 0.5rem',
    backgroundColor: 'transparent',
    '& .MuiSvgIcon-root': {
      opacity: 0.7,
      transition: 'opacity 0.3s',
    },
    '&:hover .MuiSvgIcon-root': {
      opacity: 1,
    },
    '&:hover, &:active': {
      backgroundColor: 'transparent',
    },
  };

  return {
    inputStyles,
    dividerStyles,
    visibilityToggleStyles,
  };
};
