import BorderAllIcon from '@mui/icons-material/BorderAll';
import ExtensionOffIcon from '@mui/icons-material/ExtensionOff';
import MenuIcon from '@mui/icons-material/Menu';
import PictureInPictureIcon from '@mui/icons-material/PictureInPicture'; // For picture in picture
import ViewWeekIcon from '@mui/icons-material/ViewWeek'; // For vertical split
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { Box, Card, Divider, IconButton, Tooltip } from '@mui/joy';
import React, { useState, useEffect } from 'react';
import Draggable from 'react-draggable';
import type { DraggableEvent, DraggableData } from 'react-draggable';

// Type assertion for Draggable component
const DraggableComponent = Draggable as any;
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';
import useSessionLayout from '@client/app/hooks/useSessionLayout';

export type DefaultLayoutType =
  | 'horizontal'
  | 'vertical'
  | 'pip'
  | 'noAI'
  | 'hide'
  | 'floatingChat'
  | 'dockRight'
  | 'dockBottom';

export interface LayoutControlProps {
  onLayoutChange: (layout: DefaultLayoutType) => void;
  onNoContentChange: (noContent: boolean) => void;
}

const useLayoutControl = create<{
  position: { x: number; y: number };
  setPosition: (x: number, y: number) => void;
}>()(
  // Persist layout-control position to localStorage so it survives page refresh.
  persist(
    set => ({
      position: { x: 0, y: 0 },
      setPosition: (x, y) => set({ position: { x, y } }),
    }),
    { name: 'layout-control' }
  )
);

/**
 * A component that allows the user to change the layout of the content.
 * It also allows the user to toggle the content visibility.
 *
 * @deprecated This component is deprecated and will be removed in the future.
 */
const LayoutControl: React.FC<LayoutControlProps> = ({ onLayoutChange, onNoContentChange }) => {
  const [position, setPosition] = useLayoutControl(useShallow(state => [state.position, state.setPosition]));
  const [currentLayout, setCurrentLayout] = useState<DefaultLayoutType>('hide');
  const [noContent, setNoContent] = useState<boolean>(false);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const layout = useSessionLayout(s => s.layout);

  // Update layout control's current layout state when the layout changes.
  // TODO: We have to extract the layout state from SessionContext and move it to zustand.
  useEffect(() => {
    setCurrentLayout(layout);
  }, [layout]);

  useEffect(() => {
    // Check if the device is mobile
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    handleResize(); // Initial check on mount
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  const toggleNoContent = () => {
    const newNoContentState = !noContent;
    setNoContent(newNoContentState);
    onNoContentChange(newNoContentState);
  };

  const handleLayoutChange = (layout: DefaultLayoutType) => {
    setCurrentLayout(layout);
    onLayoutChange(layout);
  };

  return !isMobile ? (
    <DraggableComponent
      handle=".drag-handle"
      position={position}
      onDrag={(e: DraggableEvent, data: DraggableData) => setPosition(data.x, data.y)}
      onStop={(e: DraggableEvent, data: DraggableData) => setPosition(data.x, data.y)}
      bounds="parent"
    >
      <Card
        className="layout-control-card"
        sx={{
          position: 'absolute',
          top: 50,
          right: 10,
          padding: '4px',
          zIndex: '999',
          backgroundColor: 'Background',
          opacity: '0.5',
          transition: 'opacity 0.3s',
          ':hover': {
            opacity: '1',
          },
        }}
      >
        <Box
          className="drag-handle layout-control-drag-handle"
          sx={{
            display: 'flex',
            margin: 'auto',
            cursor: 'grab',
            '&:active': {
              cursor: 'grabbing',
            },
          }}
        >
          <DragIndicatorIcon className="layout-control-grip-icon" />
        </Box>

        <Divider className="layout-control-divider" orientation="vertical" sx={{ width: '100%', height: '2px' }} />

        {/* Render the hide button only if the current layout is not 'hide' */}
        <IconButton
          className="layout-control-hide-button"
          variant={currentLayout === 'hide' ? 'soft' : 'solid'}
          size="sm"
          onClick={() => handleLayoutChange('hide')}
        >
          <Tooltip className="layout-control-hide-tooltip" title="Hide Knowledge" disableInteractive>
            <VisibilityOffIcon className="layout-control-hide-icon" />
          </Tooltip>
        </IconButton>
        {/* Render layout buttons based on the current layout */}
        <IconButton
          className="layout-control-horizontal-button"
          variant={currentLayout === 'horizontal' ? 'soft' : 'solid'}
          size="sm"
          onClick={() => handleLayoutChange('horizontal')}
        >
          <Tooltip className="layout-control-horizontal-tooltip" title="Horizontal" disableInteractive>
            <MenuIcon className="layout-control-horizontal-icon" />
          </Tooltip>
        </IconButton>
        <IconButton
          className="layout-control-vertical-button"
          variant={currentLayout === 'vertical' ? 'soft' : 'solid'}
          size="sm"
          onClick={() => handleLayoutChange('vertical')}
        >
          <Tooltip className="layout-control-vertical-tooltip" title="Vertical" disableInteractive>
            <ViewWeekIcon className="layout-control-vertical-icon" />
          </Tooltip>
        </IconButton>
        <IconButton
          className="layout-control-pip-button"
          variant={currentLayout === 'pip' ? 'soft' : 'solid'}
          size="sm"
          onClick={() => handleLayoutChange('pip')}
        >
          <Tooltip className="layout-control-pip-tooltip" title="Picture in Picture" disableInteractive>
            <PictureInPictureIcon className="layout-control-pip-icon" />
          </Tooltip>
        </IconButton>
        <IconButton
          className="layout-control-noai-button"
          variant={currentLayout === 'noAI' ? 'soft' : 'solid'}
          size="sm"
          onClick={() => handleLayoutChange('noAI')}
        >
          <Tooltip className="layout-control-noai-tooltip" title="Hide AI" disableInteractive>
            <ExtensionOffIcon className="layout-control-noai-icon" />
          </Tooltip>
        </IconButton>

        {/* Render the content toggle button only if the current layout is not 'hide' */}
        {currentLayout !== 'hide' && (
          <>
            <Divider
              className="layout-control-content-divider"
              orientation="vertical"
              sx={{ width: '100%', height: '2px' }}
            />

            <IconButton
              className="layout-control-toggle-content-button"
              variant={noContent ? 'soft' : 'solid'}
              size="sm"
              onClick={toggleNoContent}
            >
              <Tooltip className="layout-control-toggle-content-tooltip" title="Toggle Content" disableInteractive>
                <BorderAllIcon className="layout-control-toggle-content-icon" />
              </Tooltip>
            </IconButton>
          </>
        )}
      </Card>
    </DraggableComponent>
  ) : null;
};

export default LayoutControl;
