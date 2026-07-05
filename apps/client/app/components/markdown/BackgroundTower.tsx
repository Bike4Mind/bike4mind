import * as React from 'react';
import { Box } from '@mui/joy';

type BackgroundTowerProps = {
  src: string;
  children: React.ReactNode;
  scrollHeightVh?: number;
  imageWidthVw?: number;
  imageHeightVh?: number;
  imageAlignment?: 'center' | 'left' | 'right';
  imageOpacity?: number;
  backgroundColor?: string;
  noRepeat?: boolean;
};

const BackgroundTower: React.FC<BackgroundTowerProps> = ({
  src,
  children,
  scrollHeightVh = 100,
  imageWidthVw = 100,
  imageHeightVh = 100,
  imageAlignment = 'center',
  imageOpacity = 1,
  backgroundColor = 'transparent',
  noRepeat = true,
}) => {
  return (
    <Box
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: imageAlignment,
        backgroundImage: `url(${src})`,
        backgroundSize: `${imageWidthVw}vw`,
        backgroundPosition: `${imageAlignment} center`,
        backgroundAttachment: 'fixed',
        backgroundRepeat: noRepeat ? 'no-repeat' : 'repeat',

        width: '100vw',
        paddingLeft: '1rem',
        height: `${imageHeightVh}vh`,
        minHeight: `${scrollHeightVh}vh`,
        overflow: 'hidden',
        backgroundColor,
        '&::before': {
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'inherit',
          opacity: imageOpacity,
          zIndex: -1,
        },
      }}
    >
      {children}
    </Box>
  );
};

export default BackgroundTower;
