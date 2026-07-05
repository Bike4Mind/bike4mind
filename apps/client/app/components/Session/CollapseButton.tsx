import { Box, IconButton } from '@mui/joy';

interface CollapseButtonProps {
  isOpenedSideNav: boolean;
  onClick: () => void;
}

const CollapseButton = ({ onClick, isOpenedSideNav }: CollapseButtonProps) => {
  return (
    <IconButton
      onClick={onClick}
      sx={{
        position: 'absolute',
        px: 1,
        top: 'calc(50dvh - 20px)',
        zIndex: 500,
        width: '24px',
        height: '24px',
        minWidth: '24px',
        minHeight: '24px',
        transition: 'all 0.3s ease',
        justifyContent: isOpenedSideNav ? 'flex-start' : 'center',
        '&:hover': {
          backgroundColor: 'transparent',
          '& .collapse-button-indicator': {
            transform: isOpenedSideNav ? 'translateX(-2px)' : 'translateX(2px)',
          },
        },
      }}
    >
      <Box
        className="collapse-button-indicator"
        sx={{
          width: '2px',
          height: '24px',
          backgroundColor: theme => theme.palette.text.primary,
          borderRadius: '2px',
          opacity: 1,
          transition: 'all 0.3s ease',
        }}
      />
    </IconButton>
  );
};

export default CollapseButton;
