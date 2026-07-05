'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, IconButton, Typography, Tooltip } from '@mui/joy';
import { keyframes, styled } from '@mui/system';
import Draggable from 'react-draggable';
import type { DraggableEvent, DraggableData } from 'react-draggable';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import CloseIcon from '@mui/icons-material/Close';
import MinimizeIcon from '@mui/icons-material/Minimize';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import VerticalSplitIcon from '@mui/icons-material/VerticalSplit';
import HorizontalSplitIcon from '@mui/icons-material/HorizontalSplit';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { convertSessionToMarkdown } from '@client/app/utils/sessionMarkdownExport';

// Type assertion for Draggable component (same pattern as PromptMetaInspector)
const DraggableComponent = Draggable as React.ComponentType<{
  nodeRef: React.RefObject<HTMLElement | null>;
  handle: string;
  position: { x: number; y: number };
  onDrag: (e: DraggableEvent, data: DraggableData) => void;
  onStop: (e: DraggableEvent, data: DraggableData) => void;
  bounds: string | { left: number; top: number; right: number; bottom: number };
  children: React.ReactNode;
}>;

interface FloatingChatWindowProps {
  children: React.ReactNode;
  headerActions?: React.ReactNode;
}

// Animation for expand/collapse
const expandAnimation = keyframes`
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
`;

// Minimum and maximum size constraints
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
const MAX_WIDTH_RATIO = 0.9; // 90% of viewport
const MAX_HEIGHT_RATIO = 0.9; // 90% of viewport

// Styled resize handle component
const ResizeHandle = styled('div')<{ position: string }>(({ position }) => {
  const baseStyles: React.CSSProperties = {
    position: 'absolute',
    zIndex: 10,
  };

  const positionStyles: Record<string, React.CSSProperties> = {
    'top-left': { top: 0, left: 0, width: 12, height: 12, cursor: 'nwse-resize' },
    'top-right': { top: 0, right: 0, width: 12, height: 12, cursor: 'nesw-resize' },
    'bottom-left': { bottom: 0, left: 0, width: 12, height: 12, cursor: 'nesw-resize' },
    'bottom-right': { bottom: 0, right: 0, width: 12, height: 12, cursor: 'nwse-resize' },
    top: { top: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' },
    bottom: { bottom: 0, left: 12, right: 12, height: 6, cursor: 'ns-resize' },
    left: { left: 0, top: 12, bottom: 12, width: 6, cursor: 'ew-resize' },
    right: { right: 0, top: 12, bottom: 12, width: 6, cursor: 'ew-resize' },
  };

  return {
    ...baseStyles,
    ...positionStyles[position],
    '&:hover': {
      backgroundColor: 'rgba(var(--joy-palette-primary-mainChannel) / 0.1)',
    },
  };
});

// Get cursor style for resize handle
const getCursorForHandle = (position: string): string => {
  const cursors: Record<string, string> = {
    'top-left': 'nwse-resize',
    'top-right': 'nesw-resize',
    'bottom-left': 'nesw-resize',
    'bottom-right': 'nwse-resize',
    top: 'ns-resize',
    bottom: 'ns-resize',
    left: 'ew-resize',
    right: 'ew-resize',
  };
  return cursors[position] || 'default';
};

const FloatingChatWindow: React.FC<FloatingChatWindowProps> = ({ children, headerActions }) => {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const { currentSessionId } = useSessions();
  const queryClient = useQueryClient();

  // Get state from Zustand store
  const position = useSessionLayout(s => s.floatingChatPosition);
  const size = useSessionLayout(s => s.floatingChatSize);
  const isMinimized = useSessionLayout(s => s.floatingChatMinimized);
  const previousLayout = useSessionLayout(s => s.previousLayout);

  // Prevent wheel events from bubbling out of the floating window to parent
  // JS scroll handlers (e.g. a docked landing page). Re-attaches after minimize/
  // expand cycles since the nodeRef element unmounts when isMinimized is true.
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.stopPropagation();
    };
    el.addEventListener('wheel', handleWheel, { passive: true });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [isMinimized]);

  // Copy entire chat history as markdown to clipboard
  const handleCopyMarkdown = useCallback(async () => {
    if (!currentSessionId) return;
    try {
      const queryData = queryClient.getQueryData<InfiniteData<{ data: IChatHistoryItemDocument[] }>>([
        'quests',
        'session',
        currentSessionId,
      ]);
      if (!queryData?.pages) return;

      const quests = queryData.pages.flatMap(p => p.data).reverse(); // chronological order
      const markdown = convertSessionToMarkdown(quests);

      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy markdown:', err);
    }
  }, [currentSessionId, queryClient]);

  // Local state for drag/resize operations (for smooth updates)
  const [localPosition, setLocalPosition] = useState(position);
  const [localSize, setLocalSize] = useState(size);

  // Auto-minimize once on mount when viewport is too narrow for the floating window.
  // Only runs on initial render - if the user explicitly expands it, we respect that.
  const hasAutoMinimized = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || hasAutoMinimized.current) return;
    if (window.innerWidth < 900) {
      hasAutoMinimized.current = true;
      setSessionLayout({ floatingChatMinimized: true });
    }
  }, []);

  // Initialize position to center on first use, and clamp size to viewport
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Clamp size to viewport so the window never overflows (especially on mobile)
    const clampedWidth = Math.min(size.width, window.innerWidth * MAX_WIDTH_RATIO);
    const clampedHeight = Math.min(size.height, window.innerHeight * MAX_HEIGHT_RATIO);
    const clampedSize = { width: clampedWidth, height: clampedHeight };

    if (clampedWidth !== size.width || clampedHeight !== size.height) {
      setLocalSize(clampedSize);
      setSessionLayout({ floatingChatSize: clampedSize });
    } else {
      setLocalSize(size);
    }

    if (position.x === -1 && position.y === -1) {
      const centerX = Math.max(0, (window.innerWidth - clampedWidth) / 2);
      const centerY = Math.max(0, (window.innerHeight - clampedHeight) / 2);
      const newPosition = { x: centerX, y: centerY };
      setLocalPosition(newPosition);
      setSessionLayout({ floatingChatPosition: newPosition });
    } else {
      // Ensure existing position is still in bounds with the (possibly clamped) size
      const maxX = window.innerWidth - clampedWidth;
      const maxY = window.innerHeight - clampedHeight;
      const clampedPosition = {
        x: Math.max(0, Math.min(position.x, maxX)),
        y: Math.max(0, Math.min(position.y, maxY)),
      };
      setLocalPosition(clampedPosition);
      if (clampedPosition.x !== position.x || clampedPosition.y !== position.y) {
        setSessionLayout({ floatingChatPosition: clampedPosition });
      }
    }
  }, [position, size]);

  // Handle window resize to keep floating window in bounds
  useEffect(() => {
    const handleResize = () => {
      if (typeof window === 'undefined') return;

      const maxX = window.innerWidth - localSize.width;
      const maxY = window.innerHeight - localSize.height;

      if (localPosition.x > maxX || localPosition.y > maxY) {
        const newPosition = {
          x: Math.max(0, Math.min(localPosition.x, maxX)),
          y: Math.max(0, Math.min(localPosition.y, maxY)),
        };
        setLocalPosition(newPosition);
        setSessionLayout({ floatingChatPosition: newPosition });
      }
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [localPosition, localSize]);

  const handleDrag = useCallback((_e: DraggableEvent, data: DraggableData) => {
    setLocalPosition({ x: data.x, y: data.y });
  }, []);

  const handleDragStop = useCallback((_e: DraggableEvent, data: DraggableData) => {
    const newPosition = { x: data.x, y: data.y };
    setLocalPosition(newPosition);
    setSessionLayout({ floatingChatPosition: newPosition });
  }, []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent, handlePosition: string) => {
      e.preventDefault();
      e.stopPropagation();
      setIsResizing(true);

      const startX = e.clientX;
      const startY = e.clientY;
      const startWidth = localSize.width;
      const startHeight = localSize.height;
      const startPosX = localPosition.x;
      const startPosY = localPosition.y;

      // Prevent text selection
      document.body.style.userSelect = 'none';
      document.body.style.cursor = getCursorForHandle(handlePosition);

      // Track latest values during resize to avoid stale closure in handlePointerUp
      let latestSize = { width: startWidth, height: startHeight };
      let latestPosition = { x: startPosX, y: startPosY };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;

        let newWidth = startWidth;
        let newHeight = startHeight;
        let newX = startPosX;
        let newY = startPosY;

        const maxWidth = window.innerWidth * MAX_WIDTH_RATIO;
        const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;

        // Calculate new dimensions based on handle position
        if (handlePosition.includes('right')) {
          newWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, startWidth + deltaX));
        }
        if (handlePosition.includes('left')) {
          const potentialWidth = startWidth - deltaX;
          if (potentialWidth >= MIN_WIDTH && potentialWidth <= maxWidth) {
            newWidth = potentialWidth;
            newX = startPosX + deltaX;
          }
        }
        if (handlePosition.includes('bottom') || handlePosition === 'bottom') {
          newHeight = Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + deltaY));
        }
        if (handlePosition.includes('top') || handlePosition === 'top') {
          const potentialHeight = startHeight - deltaY;
          if (potentialHeight >= MIN_HEIGHT && potentialHeight <= maxHeight) {
            newHeight = potentialHeight;
            newY = startPosY + deltaY;
          }
        }

        // Ensure window stays in viewport
        newX = Math.max(0, Math.min(newX, window.innerWidth - newWidth));
        newY = Math.max(0, Math.min(newY, window.innerHeight - newHeight));

        // Update tracked values for handlePointerUp
        latestSize = { width: newWidth, height: newHeight };
        latestPosition = { x: newX, y: newY };

        setLocalSize(latestSize);
        setLocalPosition(latestPosition);
      };

      const handlePointerUp = () => {
        setIsResizing(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';

        // Persist the latest values captured during pointermove (not stale closure values)
        setSessionLayout({
          floatingChatSize: latestSize,
          floatingChatPosition: latestPosition,
        });

        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [localSize, localPosition]
  );

  const handleMinimize = useCallback(() => {
    if (isMinimized && typeof window !== 'undefined' && window.innerWidth < 900) {
      // Expanding on a small screen: use full viewport so the chat is usable
      const fullWidth = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
      const fullHeight = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
      const newSize = { width: fullWidth, height: fullHeight };
      const newPosition = {
        x: Math.floor((window.innerWidth - fullWidth) / 2),
        y: Math.floor((window.innerHeight - fullHeight) / 2),
      };
      setLocalSize(newSize);
      setLocalPosition(newPosition);
      setSessionLayout({
        floatingChatMinimized: false,
        floatingChatSize: newSize,
        floatingChatPosition: newPosition,
      });
    } else {
      setSessionLayout({ floatingChatMinimized: !isMinimized });
    }
  }, [isMinimized]);

  // Handle close - return to previous layout
  const handleClose = useCallback(() => {
    const targetLayout = previousLayout && previousLayout !== 'floatingChat' ? previousLayout : 'vertical';
    setSessionLayout({
      layout: targetLayout,
      floatingChatMinimized: false,
      previousLayout: undefined,
    });
  }, [previousLayout]);

  const bounds = {
    left: 0,
    top: 0,
    right: typeof window !== 'undefined' ? window.innerWidth - localSize.width : 1000,
    bottom: typeof window !== 'undefined' ? window.innerHeight - localSize.height : 800,
  };

  // Minimized state - render compact indicator
  if (isMinimized) {
    return (
      <Box
        sx={theme => ({
          position: 'fixed',
          bottom: 20,
          right: 20,
          zIndex: 1300,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: '8px 16px',
          borderRadius: '24px',
          backgroundColor: theme.palette.background.surface,
          border: '1px solid',
          borderColor: theme.palette.divider,
          boxShadow: theme.shadow.lg,
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          '&:hover': {
            transform: 'scale(1.05)',
            boxShadow: theme.shadow.xl,
          },
        })}
        onClick={handleMinimize}
        data-testid="floating-chat-minimized"
      >
        <SmartToyIcon sx={{ fontSize: 20, color: 'primary.main' }} />
        <Typography level="body-sm" fontWeight="md">
          AI Chat
        </Typography>
        <OpenInFullIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
      </Box>
    );
  }

  return (
    <DraggableComponent
      nodeRef={nodeRef}
      handle=".floating-chat-drag-handle"
      position={localPosition}
      onDrag={handleDrag}
      onStop={handleDragStop}
      bounds={bounds}
    >
      <Box
        ref={nodeRef}
        data-testid="floating-chat-window"
        sx={theme => ({
          position: 'fixed',
          width: localSize.width,
          height: localSize.height,
          zIndex: 1300,
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          backgroundColor: theme.palette.background.surface,
          border: '1px solid',
          borderColor: theme.palette.divider,
          boxShadow: theme.shadow.xl,
          overflow: 'hidden',
          animation: `${expandAnimation} 0.2s ease-out`,
          // Prevent pointer events on resize handles from triggering drag
          touchAction: isResizing ? 'none' : 'auto',
        })}
      >
        {/* Title bar / Drag handle */}
        <Box
          className="floating-chat-drag-handle"
          sx={theme => ({
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            backgroundColor: theme.palette.background.level1,
            borderBottom: '1px solid',
            borderColor: theme.palette.divider,
            cursor: 'grab',
            '&:active': {
              cursor: 'grabbing',
            },
            userSelect: 'none',
          })}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <DragIndicatorIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
            <SmartToyIcon sx={{ fontSize: 18, color: 'primary.main' }} />
            <Typography level="body-sm" fontWeight="md">
              AI Chat
            </Typography>
          </Box>

          {/* Stop all event propagation so react-draggable doesn't swallow taps on mobile */}
          <Box
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
            onTouchStart={e => e.stopPropagation()}
            onMouseDown={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
          >
            {headerActions}
            <Tooltip title={copied ? 'Copied!' : 'Copy chat as Markdown'} disableInteractive>
              <IconButton
                size="sm"
                variant="plain"
                color={copied ? 'success' : 'neutral'}
                onClick={handleCopyMarkdown}
                data-testid="floating-chat-copy-markdown"
                sx={{ '--IconButton-size': '28px' }}
              >
                {copied ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 14 }} />}
              </IconButton>
            </Tooltip>
            <Tooltip title="Dock right" disableInteractive>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => setSessionLayout({ layout: 'dockRight' })}
                data-testid="floating-chat-dock-right"
                sx={{ '--IconButton-size': '28px' }}
              >
                <VerticalSplitIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Dock bottom" disableInteractive>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={() => setSessionLayout({ layout: 'dockBottom' })}
                data-testid="floating-chat-dock-bottom"
                sx={{ '--IconButton-size': '28px' }}
              >
                <HorizontalSplitIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Minimize" disableInteractive>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={handleMinimize}
                onTouchEnd={e => {
                  e.preventDefault();
                  handleMinimize();
                }}
                data-testid="floating-chat-minimize"
                sx={{ '--IconButton-size': '36px', minWidth: '36px', minHeight: '36px' }}
              >
                <MinimizeIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Close floating chat" disableInteractive>
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                onClick={handleClose}
                onTouchEnd={e => {
                  e.preventDefault();
                  handleClose();
                }}
                data-testid="floating-chat-close"
                sx={{ '--IconButton-size': '36px', minWidth: '36px', minHeight: '36px' }}
              >
                <CloseIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        {/* Chat content */}
        <Box
          sx={{
            flex: 1,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {children}
        </Box>

        {/* Resize handles */}
        {['top', 'right', 'bottom', 'left', 'top-left', 'top-right', 'bottom-left', 'bottom-right'].map(handlePos => (
          <ResizeHandle
            key={handlePos}
            position={handlePos}
            onPointerDown={e => handleResizeStart(e, handlePos)}
            data-testid={`resize-handle-${handlePos}`}
          />
        ))}
      </Box>
    </DraggableComponent>
  );
};

export default FloatingChatWindow;
