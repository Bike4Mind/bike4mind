import React, { useEffect, useState } from 'react';
import { Box, Typography, IconButton } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useNavigate } from '@tanstack/react-router';

interface AgentPageHeaderProps {
  // Left side content
  title: string;
  subtitle?: string;
  backButton?: boolean;
  backTo?: string;
  onBack?: () => void;

  // Icon next to title (when backButton is false)
  titleIcon?: React.ReactNode;

  // Right side content - slots for maximum flexibility
  rightActions?: React.ReactNode;

  // Styling
  isScrolled?: boolean;
  className?: string;
  sx?: any;

  // Scroll container ref for auto-scroll detection
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
}

const AgentPageHeader: React.FC<AgentPageHeaderProps> = ({
  title,
  backButton = true,
  backTo = '/agents',
  onBack,
  titleIcon,
  rightActions,
  isScrolled: externalIsScrolled,
  className,
  sx = {},
  scrollContainerRef,
}) => {
  const navigate = useNavigate();
  const [internalIsScrolled, setInternalIsScrolled] = useState(false);

  // Use external isScrolled if provided, otherwise use internal state
  const isScrolled = externalIsScrolled !== undefined ? externalIsScrolled : internalIsScrolled;

  // Handle scroll for compact header (only if scrollContainerRef is provided and no external isScrolled)
  useEffect(() => {
    if (externalIsScrolled !== undefined || !scrollContainerRef?.current) return;

    const scrollContainer = scrollContainerRef.current;
    let timeoutId: NodeJS.Timeout;
    let lastScrollTop = 0;
    let isScrolling = false;

    const handleScroll = () => {
      if (isScrolling) return;
      isScrolling = true;

      clearTimeout(timeoutId);

      timeoutId = setTimeout(() => {
        const scrollTop = scrollContainer.scrollTop;

        if (Math.abs(scrollTop - lastScrollTop) > 0) {
          const newIsScrolled = scrollTop > 0;
          setInternalIsScrolled(prev => {
            if (prev !== newIsScrolled) {
              lastScrollTop = scrollTop;
              return newIsScrolled;
            }
            return prev;
          });
        }

        isScrolling = false;
      }, 16);
    };

    scrollContainer.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      clearTimeout(timeoutId);
    };
  }, [externalIsScrolled, scrollContainerRef]);

  const handleBack = () => {
    console.log('AgentPageHeader handleBack called', { onBack, backTo });

    if (onBack) {
      console.log('Using onBack prop');
      onBack();
    } else {
      console.log('Using backTo navigation', backTo);
      navigate({ to: backTo as any });
    }
  };

  return (
    <Box
      className={className}
      sx={{
        position: 'sticky',
        top: 0,
        zIndex: 200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        boxShadow: '0px 1px 20px rgba(51, 95, 112, 0.04)',
        borderBottom: '1px solid',
        padding: isScrolled ? { xs: '12px 16px', sm: '12px 24px' } : { xs: '18px 16px', sm: '24px 24px' },
        mb: 3,
        maxHeight: '80px',
        transition: 'padding 0.2s ease',
        borderBottomColor: theme => theme.palette.border.muted,
        backgroundColor: theme => theme.palette.background.surface2,
        ...sx,
      }}
    >
      {/* Left side */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        {backButton ? (
          <IconButton
            sx={{ width: '32px', height: '32px', minWidth: '32px', minHeight: '32px', mr: 0 }}
            onClick={handleBack}
            color="neutral"
            variant="plain"
          >
            <ArrowBackIcon sx={{ fontSize: '18px', color: 'text.primary' }} />
          </IconButton>
        ) : titleIcon ? (
          <Box sx={{ display: { xs: 'none', sm: 'flex' }, alignItems: 'center', mr: 1 }}>{titleIcon}</Box>
        ) : null}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, minWidth: 0, flex: 1 }}>
          <Typography
            data-testid="agent-page-heading"
            level="h4"
            sx={{
              fontWeight: 400,
              fontSize: { xs: '18px', sm: '20px' },
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {title}
          </Typography>
        </Box>
      </Box>

      {/* Right side - flexible slot */}
      {rightActions && <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>{rightActions}</Box>}
    </Box>
  );
};

export default AgentPageHeader;
