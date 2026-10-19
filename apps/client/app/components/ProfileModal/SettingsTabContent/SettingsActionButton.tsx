import { Button, styled } from '@mui/joy';

// Common style for the action buttons on the General settings cards.
const SettingsActionButton = styled(Button)(({ theme }) => ({
  gap: '.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  whiteSpace: 'normal',
  flexDirection: 'row',
  height: '28px',
  minHeight: '28px',
  [theme.breakpoints.down('sm')]: {
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: 'center',
    height: 'auto',
    minHeight: '28px',
    paddingTop: '6px',
    paddingBottom: '6px',
  },
}));

export default SettingsActionButton;
