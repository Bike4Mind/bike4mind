import { brand } from '@client/app/utils/themes/colors';

export const scrollbarStyles = {
  '&::-webkit-scrollbar': {
    width: { xs: '0px', sm: '4px' },
  },
  '&::-webkit-scrollbar-track': {
    background: 'transparent',
  },
  '&::-webkit-scrollbar-thumb': {
    background: brand[800],
    borderRadius: '3px',
  },
  '&::-webkit-scrollbar-thumb:hover': {
    background: brand[900],
  },
};
