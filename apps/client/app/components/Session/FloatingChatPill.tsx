'use client';

import React, { useLayoutEffect, useRef, useState } from 'react';
import { Box, Typography } from '@mui/joy';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import Draggable from 'react-draggable';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { adminSurfaceExcludeProps } from '@client/app/utils/themes/customizations/adminSkin';

const EDGE_GAP = 20;
const DRAG_THRESHOLD = 5;

export default function FloatingChatPill({ onExpand }: { onExpand: () => void }) {
  const nodeRef = useRef<HTMLButtonElement>(null);
  const savedPosition = useSessionLayout(state => state.floatingChatPillPosition);
  const [position, setPosition] = useState(savedPosition ?? { x: 0, y: 0 });
  const [bounds, setBounds] = useState({ left: 0, top: 0, right: 0, bottom: 0 });
  const dragStart = useRef(position);
  const dragged = useRef(false);

  useLayoutEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const updateBounds = () => {
      const right = Math.max(0, window.innerWidth - node.offsetWidth);
      const bottom = Math.max(0, window.innerHeight - node.offsetHeight);
      const current = useSessionLayout.getState().floatingChatPillPosition ?? {
        x: right - EDGE_GAP,
        y: bottom - EDGE_GAP,
      };
      const next = {
        x: Math.max(0, Math.min(current.x, right)),
        y: Math.max(0, Math.min(current.y, bottom)),
      };
      setBounds({ left: 0, top: 0, right, bottom });
      setPosition(next);
      if (!savedPosition || next.x !== current.x || next.y !== current.y) {
        setSessionLayout({ floatingChatPillPosition: next });
      }
    };

    updateBounds();
    window.addEventListener('resize', updateBounds);
    const observer = new ResizeObserver(updateBounds);
    observer.observe(node);
    return () => {
      window.removeEventListener('resize', updateBounds);
      observer.disconnect();
    };
  }, [savedPosition]);

  return (
    <Draggable
      nodeRef={nodeRef}
      position={position}
      bounds={bounds}
      onStart={(_event, data) => {
        dragStart.current = { x: data.x, y: data.y };
        dragged.current = false;
      }}
      onDrag={(_event, data) => {
        if (Math.hypot(data.x - dragStart.current.x, data.y - dragStart.current.y) > DRAG_THRESHOLD) {
          dragged.current = true;
        }
        setPosition({ x: data.x, y: data.y });
      }}
      onStop={(event, data) => {
        setSessionLayout({ floatingChatPillPosition: { x: data.x, y: data.y } });
        if (event.type === 'touchend') {
          event.preventDefault();
          if (!dragged.current) onExpand();
        }
      }}
    >
      <Box
        component="button"
        type="button"
        ref={nodeRef}
        data-testid="floating-chat-minimized"
        aria-label="Open AI chat"
        title="Click to open AI chat. Drag to move."
        {...adminSurfaceExcludeProps}
        onClick={event => {
          if (!dragged.current || event.detail === 0) onExpand();
        }}
        sx={theme => ({
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 1300,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: '8px 16px',
          border: 0,
          borderRadius: '24px',
          backgroundColor: theme.palette.primary.solidBg,
          color: theme.palette.primary.solidColor,
          '--Icon-color': theme.palette.primary.solidColor,
          boxShadow: theme.shadow.lg,
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          transition: 'background-color 0.2s ease',
          '&:hover': { backgroundColor: theme.palette.primary.solidHoverBg },
          '&:active': { cursor: 'grabbing' },
        })}
      >
        <DragIndicatorIcon sx={{ fontSize: 16 }} />
        <SmartToyIcon sx={{ fontSize: 16 }} />
        <Typography level="body-sm" fontWeight="md" sx={{ color: 'inherit' }}>
          AI Chat
        </Typography>
      </Box>
    </Draggable>
  );
}
