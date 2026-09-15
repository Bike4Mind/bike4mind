import React, { useState } from 'react';
import { Box, Card, Chip, Typography, Tooltip, Stack, Badge } from '@mui/joy';
import { keyframes } from '@mui/system';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import NotificationsActiveIcon from '@mui/icons-material/NotificationsActive';
import AnnouncementIcon from '@mui/icons-material/Announcement';
import InfoIcon from '@mui/icons-material/Info';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import StarIcon from '@mui/icons-material/Star';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import GroupIcon from '@mui/icons-material/Group';

// Animations
const shimmer = keyframes`
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
`;

const pulse = keyframes`
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.85;
  }
`;

const slideIn = keyframes`
  from {
    transform: translateY(-10px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
`;

interface ModalPreviewCardProps {
  modal: {
    id: string;
    title: string;
    content?: string;
    enabled: boolean;
    type: 'modal' | 'banner';
    priority: number;
    tags?: string[];
    startDate?: string;
    endDate?: string;
    icon?: string;
    imageUrl?: string;
    primaryButtonText?: string;
    secondaryButtonText?: string;
    dismissible?: boolean;
    style?: {
      backgroundColor?: string;
      textColor?: string;
      borderColor?: string;
    };
  };
  index: number;
}

// Mini preview of the actual modal/banner
const MiniPreview = ({
  modal,
  showFullPreview,
  setShowFullPreview,
  isHovered,
  setIsHovered,
  getIcon,
}: {
  modal: ModalPreviewCardProps['modal'];
  showFullPreview: boolean;
  setShowFullPreview: (show: boolean) => void;
  isHovered: boolean;
  setIsHovered: (hovered: boolean) => void;
  getIcon: () => React.ReactNode;
}) => (
  <Box
    sx={{
      position: 'relative',
      width: '100%',
      height: showFullPreview ? 'auto' : '120px',
      background:
        modal.style?.backgroundColor ||
        (modal.type === 'banner' ? 'var(--joy-palette-primary-softBg)' : 'var(--joy-palette-warning-softBg)'),
      border: '1px solid',
      borderColor: modal.type === 'banner' ? 'primary.outlinedBorder' : 'warning.outlinedBorder',
      borderRadius: 'md',
      p: 2,
      overflow: 'hidden',
      transition: 'box-shadow 0.1s ease, opacity 0.2s ease',
      cursor: 'pointer',
      boxShadow: isHovered ? 'sm' : 'xs',
      opacity: isHovered ? 1 : 0.95,
      willChange: 'box-shadow, opacity', // Optimize transitions
      '&::before': {
        content: '""',
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background:
          'linear-gradient(90deg, transparent, var(--joy-palette-common-white, rgba(255,255,255,0.05)), transparent)',
        backgroundSize: '200% 100%',
        animation: isHovered ? `${shimmer} 5s ease-in-out` : 'none',
        pointerEvents: 'none', // Don't block scroll/click interactions
      },
    }}
    onClick={() => setShowFullPreview(!showFullPreview)}
    onMouseEnter={() => setIsHovered(true)}
    onMouseLeave={() => setIsHovered(false)}
  >
    {/* Modal/Banner Content Preview */}
    <Stack spacing={1} sx={{ position: 'relative', zIndex: 1 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            color: modal.style?.textColor || (modal.type === 'banner' ? 'primary.solidColor' : 'warning.solidColor'),
            animation: modal.enabled ? `${pulse} 3s infinite ease-in-out` : 'none',
          }}
        >
          {getIcon()}
        </Box>
        <Typography
          level="title-md"
          sx={{
            color: modal.style?.textColor || (modal.type === 'banner' ? 'text.primary' : 'text.primary'),
            fontWeight: 'bold',
          }}
        >
          {modal.title}
        </Typography>
      </Box>

      {(showFullPreview || !modal.content) && modal.content && (
        <Typography
          level="body-sm"
          sx={{
            color: modal.style?.textColor || (modal.type === 'banner' ? 'primary.plainColor' : 'warning.plainColor'),
            display: '-webkit-box',
            WebkitLineClamp: showFullPreview ? 'unset' : 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            animation: `${slideIn} 0.3s ease`,
          }}
        >
          {modal.content}
        </Typography>
      )}

      {showFullPreview && modal.imageUrl && (
        <Box
          component="img"
          src={modal.imageUrl}
          alt={modal.title}
          sx={{
            width: '100%',
            maxHeight: '200px',
            objectFit: 'cover',
            borderRadius: 'sm',
            mt: 1,
            animation: `${slideIn} 0.4s ease`,
            boxShadow: 'md',
          }}
        />
      )}

      {showFullPreview && (
        <Box sx={{ display: 'flex', gap: 1, mt: 1, animation: `${slideIn} 0.3s ease` }}>
          {modal.primaryButtonText && (
            <Box
              sx={{
                px: 2,
                py: 0.5,
                bgcolor: modal.type === 'banner' ? 'primary.solidBg' : 'warning.solidBg',
                borderRadius: 'sm',
                backdropFilter: 'blur(10px)',
                fontSize: '12px',
                color: modal.type === 'banner' ? 'primary.solidColor' : 'warning.solidColor',
                fontWeight: 'bold',
              }}
            >
              {modal.primaryButtonText}
            </Box>
          )}
          {modal.secondaryButtonText && (
            <Box
              sx={{
                px: 2,
                py: 0.5,
                border: '1px solid',
                borderColor: modal.type === 'banner' ? 'primary.outlinedBorder' : 'warning.outlinedBorder',
                borderRadius: 'sm',
                fontSize: '12px',
                color: modal.type === 'banner' ? 'primary.outlinedColor' : 'warning.outlinedColor',
              }}
            >
              {modal.secondaryButtonText}
            </Box>
          )}
        </Box>
      )}
    </Stack>

    {/* Decorative elements */}
    <Box
      sx={{
        position: 'absolute',
        top: -20,
        right: -20,
        width: 100,
        height: 100,
        borderRadius: '50%',
        bgcolor: 'background.level1',
        filter: 'blur(40px)',
        pointerEvents: 'none', // Don't block interactions
      }}
    />
    <Box
      sx={{
        position: 'absolute',
        bottom: -30,
        left: -30,
        width: 120,
        height: 120,
        borderRadius: '50%',
        bgcolor: 'background.level2',
        filter: 'blur(40px)',
        pointerEvents: 'none', // Don't block interactions
      }}
    />
  </Box>
);

export const ModalPreviewCard: React.FC<ModalPreviewCardProps> = ({ modal, index }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [showFullPreview, setShowFullPreview] = useState(false);

  // Icon selection based on type/content
  const getIcon = () => {
    if (modal.icon === 'info') return <InfoIcon />;
    if (modal.icon === 'success') return <CheckCircleIcon />;
    if (modal.icon === 'error') return <ErrorIcon />;
    if (modal.icon === 'star') return <StarIcon />;
    if (modal.type === 'banner') return <AnnouncementIcon />;
    return <NotificationsActiveIcon />;
  };

  // Priority color
  const getPriorityColor = () => {
    if (modal.priority >= 8) return 'danger';
    if (modal.priority >= 5) return 'warning';
    if (modal.priority >= 3) return 'primary';
    return 'neutral';
  };

  return (
    <Card
      variant="outlined"
      sx={{
        p: 2,
        animation: `${slideIn} ${0.3 + index * 0.1}s ease`,
        transition: 'box-shadow 0.2s ease',
        '&:hover': {
          boxShadow: 'md',
        },
      }}
    >
      <Stack spacing={2}>
        {/* Header with status and type */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Stack spacing={1}>
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Typography
                level="h4"
                sx={{
                  fontWeight: 'bold',
                  color: 'text.primary',
                }}
              >
                {index + 1}. {modal.title}
              </Typography>
              <Badge
                badgeContent={modal.priority}
                color={getPriorityColor()}
                sx={{
                  '& .MuiBadge-badge': {
                    right: -3,
                    top: 3,
                    animation: modal.priority >= 8 ? `${pulse} 2.5s infinite` : 'none',
                  },
                }}
              >
                <AutoAwesomeIcon sx={{ fontSize: 16, color: 'warning.400' }} />
              </Badge>
            </Box>

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
              <Chip
                size="sm"
                variant="soft"
                color={modal.enabled ? 'success' : 'neutral'}
                startDecorator={modal.enabled ? <VisibilityIcon /> : <VisibilityOffIcon />}
              >
                {modal.enabled ? 'Live' : 'Draft'}
              </Chip>

              <Chip
                size="sm"
                variant="soft"
                color={modal.type === 'banner' ? 'primary' : 'warning'}
                startDecorator={modal.type === 'banner' ? <AnnouncementIcon /> : <NotificationsActiveIcon />}
              >
                {modal.type === 'banner' ? 'Banner' : 'Modal'}
              </Chip>

              {modal.tags && modal.tags.length > 0 && (
                <Tooltip title={`Targeting: ${modal.tags.join(', ')}`}>
                  <Chip size="sm" variant="outlined" startDecorator={<GroupIcon />}>
                    {modal.tags.length} {modal.tags.length === 1 ? 'tag' : 'tags'}
                  </Chip>
                </Tooltip>
              )}
            </Box>
          </Stack>

          <Stack spacing={0.5} alignItems="flex-end">
            <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
              ID: {modal.id.slice(0, 8)}
            </Typography>
            {modal.startDate && (
              <Chip size="sm" variant="outlined" startDecorator={<AccessTimeIcon />} sx={{ fontSize: '11px' }}>
                {new Date(modal.startDate).toLocaleDateString()} → {new Date(modal.endDate || '').toLocaleDateString()}
              </Chip>
            )}
          </Stack>
        </Box>

        {/* Visual Preview */}
        <MiniPreview
          modal={modal}
          showFullPreview={showFullPreview}
          setShowFullPreview={setShowFullPreview}
          isHovered={isHovered}
          setIsHovered={setIsHovered}
          getIcon={getIcon}
        />

        {/* Metadata */}
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {modal.tags?.map((tag, i) => (
            <Chip
              key={i}
              size="sm"
              variant="soft"
              sx={{
                bgcolor: ['primary.softBg', 'warning.softBg', 'success.softBg', 'danger.softBg', 'neutral.softBg'][
                  i % 5
                ],
                color: [
                  'primary.softColor',
                  'warning.softColor',
                  'success.softColor',
                  'danger.softColor',
                  'neutral.softColor',
                ][i % 5],
                fontWeight: 'bold',
                animation: `${slideIn} ${0.5 + i * 0.1}s ease`,
              }}
            >
              {tag}
            </Chip>
          ))}
        </Box>

        {/* Click hint */}
        <Typography
          level="body-xs"
          sx={{
            textAlign: 'center',
            color: 'text.tertiary',
            fontStyle: 'italic',
            opacity: 0.8,
          }}
        >
          ✨ Click preview above to expand
        </Typography>
      </Stack>
    </Card>
  );
};
