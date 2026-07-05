import React, { useState, useEffect } from 'react';
import { Box, IconButton, Typography } from '@mui/joy';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import { useLogEvent } from '@client/app/hooks/data/analytics';
import { ANALYTICS_EVENTS } from '@server/types/analytics';
import { IModal } from '@bike4mind/common';

interface ConfigurableBannerProps {
  bannerId: IModal['_id'];
  isEnabled: boolean;
  startDateTime: string;
  endDateTime: string;
  imageUrl?: string;
  textMessage?: string;
  onClose: () => void;
}

const ConfigurableBanner: React.FC<ConfigurableBannerProps> = ({
  bannerId,
  isEnabled,
  startDateTime,
  endDateTime,
  imageUrl,
  textMessage,
  onClose,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const logEvent = useLogEvent();

  useEffect(() => {
    const checkVisibility = () => {
      const now = new Date();
      const start = new Date(startDateTime);
      const end = new Date(endDateTime);

      const isWithinTimeRange = now >= start && now <= end;

      setIsVisible(isEnabled && isWithinTimeRange);
    };

    checkVisibility();
    const timer = setInterval(checkVisibility, 4 * 60 * 60 * 1000); // Check every four hours

    return () => clearInterval(timer);
  }, [isEnabled, startDateTime, endDateTime]);

  const handleClose = () => {
    setIsClosing(true);

    setTimeout(() => {
      setIsVisible(false);
      setIsClosing(false);

      logEvent.mutate({ type: ANALYTICS_EVENTS.VIEW_BANNER, metadata: { id: bannerId } });
      onClose();
    }, 300);
  };

  const bannerAnimation = {
    transition: 'transform 0.3s ease-in-out, opacity 0.3s ease-in-out',
    transform: isVisible && !isClosing ? 'translateY(0)' : 'translateY(-100%)',
    opacity: isVisible && !isClosing ? 1 : 0,
  };

  return (
    <Box
      sx={{
        width: '100%',
        bgcolor: 'primary.700',
        color: 'common.white',
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 10000,
        ...bannerAnimation,
      }}
    >
      <Box
        sx={{
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingRight: 12,
        }}
      >
        {imageUrl ? (
          <img src={imageUrl} alt="Banner" style={{ width: 'auto' }} />
        ) : (
          <Typography level="h2" component="p">
            {textMessage}
          </Typography>
        )}
        <IconButton
          onClick={handleClose}
          sx={{
            color: 'common.white',
            position: 'absolute',
            right: 0,
            top: 0,
            '&:hover': {
              bgcolor: 'primary.600',
            },
          }}
          aria-label="Close banner"
        >
          <CloseRoundedIcon sx={{ color: 'common.white' }} />
        </IconButton>
      </Box>
    </Box>
  );
};

export default ConfigurableBanner;
