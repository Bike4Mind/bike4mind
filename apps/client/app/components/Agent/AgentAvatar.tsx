import React, { useState } from 'react';
import { Avatar, Box, Typography, Modal, ModalDialog, ModalClose, IconButton } from '@mui/joy';
import { SxProps } from '@mui/joy/styles/types';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import ZoomInIcon from '@mui/icons-material/ZoomIn';

/**
 * Deterministic hue (0-359) from an agent name. Same name always maps to the
 * same hue, so each agent reads distinctly at a glance when it has no portrait.
 */
const hueFromName = (name: string): number => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash % 360);
};

/** Deterministic solid avatar color from an agent name. */
export const getAgentAvatarColor = (name: string): string => `hsl(${hueFromName(name)}, 65%, 52%)`;

/**
 * Diagonal gradient built from an agent's deterministic hue. Both stops are
 * valid `hsl()` colors; the darker bottom-right stop adds depth and keeps the
 * white initial legible. (The previous `${color}dd` suffix appended a hex-alpha
 * byte to an `hsl()` string, producing invalid CSS that collapsed the gradient
 * to a flat panel fill, which caused the uniform grey squares.)
 */
export const getAgentAvatarGradient = (name: string): string => {
  const hue = hueFromName(name);
  return `linear-gradient(135deg, hsl(${hue}, 65%, 52%) 0%, hsl(${hue}, 65%, 40%) 100%)`;
};

/**
 * sx fragment for an inline MUI Joy `<Avatar>` letter fallback: a name-derived
 * gradient with legible white text, applied for any non-empty name. A portrait
 * `<img>`, when present and loaded, covers this background; if it fails to load
 * the gradient still shows behind the initial. Spread into the Avatar's sx.
 */
export const agentAvatarFallbackSx = (name: string) =>
  name && name.trim() !== '' ? { background: getAgentAvatarGradient(name), color: '#fff' } : {};

interface AgentAvatarProps {
  /** Agent name - first letter will be shown as fallback */
  name: string;
  /** URL to agent portrait image */
  portraitUrl?: string | null;
  /** Size of the avatar in pixels - can be responsive */
  size?: number | { xs?: number; sm?: number; md?: number; lg?: number; xl?: number };
  /** Custom sx props for the Avatar container */
  sx?: SxProps;
  /** Whether avatar is clickable */
  onClick?: () => void;
  /** Alt text for image (defaults to agent name) */
  alt?: string;
  /** Custom border radius */
  borderRadius?: string | number;
  /** Drag event handlers for image upload */
  onDragEnter?: (e: React.DragEvent<any>) => void;
  onDragLeave?: (e: React.DragEvent<any>) => void;
  onDragOver?: (e: React.DragEvent<any>) => void;
  onDrop?: (e: React.DragEvent<any>) => void;
  /** Show zoom icon that opens a lightbox to view full-size image */
  showZoom?: boolean;
}

/**
 * Reusable Agent Avatar Component
 *
 * Display priority:
 * 1. Agent portrait image (if portraitUrl provided)
 * 2. First letter of agent name on gradient background (if valid name)
 * 3. Robot icon (if no name, empty name, or default "Agent" text)
 *
 * Features:
 * - Unique gradient color per agent (generated from name)
 * - Drag-and-drop support for image upload
 * - Click handlers
 * - Customizable size and styling
 *
 * @example
 * ```tsx
 * // With real agent name - shows "M" on gradient
 * <AgentAvatar
 *   name="MyHelper"
 *   portraitUrl={agent.visual?.portraitUrl}
 *   size={100}
 * />
 *
 * // With default/empty name - shows robot icon
 * <AgentAvatar
 *   name="Agent"
 *   portraitUrl={null}
 *   size={120}
 * />
 *
 * // With drag-and-drop support
 * <AgentAvatar
 *   name="Assistant"
 *   portraitUrl={url}
 *   size={120}
 *   onClick={openFileBrowser}
 *   onDrop={handleImageDrop}
 * />
 * ```
 */
export const AgentAvatar: React.FC<AgentAvatarProps> = ({
  name,
  portraitUrl,
  size = 100,
  sx = {},
  onClick,
  alt,
  onDragEnter,
  onDragLeave,
  onDragOver,
  onDrop,
  showZoom = false,
}) => {
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  const handleZoomClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering parent onClick
    setIsZoomOpen(true);
  };
  // Check if we should show the robot icon (no real name provided)
  const hasNoName = !name || name.trim() === '';
  const firstLetter = name.charAt(0).toUpperCase();

  // Helper to calculate font size based on size (handles responsive objects)
  const calculateFontSize = (multiplier: number) => {
    if (typeof size === 'number') {
      return `${size * multiplier}px`;
    }
    // For responsive objects, calculate for each breakpoint
    const responsiveSize: any = {};
    Object.entries(size).forEach(([key, value]) => {
      responsiveSize[key] = `${value * multiplier}px`;
    });
    return responsiveSize;
  };

  return (
    <>
      <Box sx={{ position: 'relative', display: 'inline-block' }}>
        <Avatar
          src={portraitUrl || ''} // Priority 1: Show portrait if available
          alt={alt || name}
          sx={{
            width: size,
            height: size,
            cursor: onClick ? 'pointer' : 'default',
            transition: 'transform 0.2s ease',
            backgroundColor: theme => theme.palette.background.panel,
            overflow: 'hidden',
            borderRadius: '8px',
            border: '1px solid',
            borderColor: 'border.soft',
            ...sx,
          }}
          onClick={onClick}
          onDragEnter={onDragEnter}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          {!portraitUrl && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                height: '100%',
                background: hasNoName ? 'transparent' : getAgentAvatarGradient(name),
              }}
            >
              {hasNoName ? (
                <SmartToyOutlinedIcon
                  sx={{
                    fontSize: calculateFontSize(0.48),
                    color: 'text.primary50',
                  }}
                />
              ) : (
                <Typography
                  sx={{
                    // White matches the inline fallbacks (agentAvatarFallbackSx) so an
                    // agent's initial reads identically here and in the sidenav/bench/chips.
                    color: '#fff',
                    fontSize: calculateFontSize(0.4),
                    fontWeight: 600,
                    userSelect: 'none',
                  }}
                >
                  {firstLetter}
                </Typography>
              )}
            </Box>
          )}
        </Avatar>

        {/* Zoom icon - only show when there's a portrait image */}
        {showZoom && portraitUrl && (
          <IconButton
            size="sm"
            variant="solid"
            onClick={handleZoomClick}
            aria-label="View full-size portrait"
            sx={{
              position: 'absolute',
              bottom: 4,
              right: 4,
              width: 24,
              height: 24,
              minWidth: 24,
              minHeight: 24,
              backgroundColor: 'rgba(0, 0, 0, 0.6)',
              color: 'white',
              borderRadius: '4px',
              '&:hover': {
                backgroundColor: 'rgba(0, 0, 0, 0.8)',
              },
              zIndex: 2,
            }}
          >
            <ZoomInIcon sx={{ fontSize: 14 }} />
          </IconButton>
        )}
      </Box>

      {/* Lightbox Modal */}
      <Modal open={isZoomOpen} onClose={() => setIsZoomOpen(false)}>
        <ModalDialog
          sx={{
            p: 0,
            border: 'none',
            backgroundColor: 'transparent',
            boxShadow: 'none',
            maxWidth: '90vw',
            maxHeight: '90vh',
            overflow: 'visible',
          }}
        >
          <ModalClose
            sx={{
              position: 'absolute',
              top: -12,
              right: -12,
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              color: 'white',
              borderRadius: '50%',
              zIndex: 10,
              '&:hover': {
                backgroundColor: 'rgba(0, 0, 0, 0.9)',
              },
            }}
          />
          {portraitUrl && (
            <Box
              component="img"
              src={portraitUrl}
              alt={alt || name}
              sx={{
                maxWidth: '90vw',
                maxHeight: '85vh',
                objectFit: 'contain',
                borderRadius: '8px',
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
              }}
            />
          )}
        </ModalDialog>
      </Modal>
    </>
  );
};

export default AgentAvatar;
