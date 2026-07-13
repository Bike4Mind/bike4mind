import { Close } from '@mui/icons-material';
import { Button, Box } from '@mui/joy';
import React, { FC, useCallback, useEffect, useRef, useState } from 'react';
import { useChatInput } from '@client/app/hooks/useChatInput';

// These could be moved to a constants file or settings later
const EXPLAIN_PROMPT = 'I do not understand, please explain this in detail to me:\n\n"{{text}}"';
const IMPROVE_PROMPT =
  'I am confident that you can do much better than this, please improve this material:\n\n"{{text}}"';

interface QuoteActionsProps {
  containerRef: React.RefObject<HTMLElement | null>;
}

export const QuoteActions: FC<QuoteActionsProps> = ({ containerRef }) => {
  const [selectedText, setSelectedText] = useState('');
  const [floatingButtonsPosition, setFloatingButtonsPosition] = useState({ x: 0, y: 0 });
  const [showFloatingButtons, setShowFloatingButtons] = useState(false);
  const setChatInputValue = useChatInput(s => s.setChatInputValue);
  const floatingButtonsRef = useRef<HTMLDivElement>(null);

  // This feature is driven entirely by desktop mouse events (mouseup/mousedown).
  // On touch devices those events are emulated mid long-press / handle-drag, so
  // clearing and re-reading the selection actively fights the native touch
  // selection and makes partial copy glitchy. Gate it to fine (mouse) pointers.
  const [isFinePointer, setIsFinePointer] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: fine)');
    setIsFinePointer(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsFinePointer(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const handleTextSelection = useCallback(() => {
    // short delay to allow the selection to be made
    setTimeout(() => {
      const selection = window.getSelection();
      const selectionText = selection?.toString().trim() || '';

      if (selectionText) {
        const range = selection?.getRangeAt(0);
        const rect = range?.getBoundingClientRect();
        if (rect) {
          setSelectedText(selectionText);
          setFloatingButtonsPosition({
            x: rect.left + rect.width / 2,
            y: rect.top,
          });
          setShowFloatingButtons(true);
        }
      } else {
        setShowFloatingButtons(false);
      }
    }, 100);
  }, []);

  const handleTextAction = useCallback(
    (text: string) => {
      setChatInputValue(text);
      setShowFloatingButtons(false);
    },
    [setChatInputValue]
  );

  const clearSelection = useCallback(() => {
    setShowFloatingButtons(false);
    setSelectedText('');
    if (window.getSelection) {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  useEffect(() => {
    if (!isFinePointer) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideContainer = containerRef.current?.contains(target);
      const isInsideFloatingButtons = floatingButtonsRef.current?.contains(target);

      if (showFloatingButtons && !isInsideContainer && !isInsideFloatingButtons) {
        clearSelection();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isFinePointer, containerRef, showFloatingButtons, clearSelection]);

  useEffect(() => {
    if (!isFinePointer) return;

    const element = containerRef.current;
    if (element) {
      element.addEventListener('mouseup', handleTextSelection);
      return () => {
        element.removeEventListener('mouseup', handleTextSelection);
      };
    }
  }, [isFinePointer, containerRef, handleTextSelection]);

  if (!isFinePointer || !showFloatingButtons) return null;

  return (
    <FloatingButtons
      ref={floatingButtonsRef}
      position={floatingButtonsPosition}
      selectedText={selectedText}
      onAction={handleTextAction}
      onCancel={clearSelection}
    />
  );
};

interface FloatingButtonsProps {
  position: { x: number; y: number };
  selectedText: string;
  onAction: (text: string) => void;
  onCancel: () => void;
}

const FloatingButtons = React.forwardRef<HTMLDivElement, FloatingButtonsProps>(
  ({ position, selectedText, onAction, onCancel }, ref) => {
    const handleExplain = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const prompt = EXPLAIN_PROMPT.replace('{{text}}', selectedText);
      onAction(prompt);
    };

    const handleImprove = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const prompt = IMPROVE_PROMPT.replace('{{text}}', selectedText);
      onAction(prompt);
    };

    const handleQuote = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onAction(`"${selectedText}"`);
    };

    const handleCancelClick = (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    };

    return (
      <Box
        ref={ref}
        onClick={e => e.stopPropagation()}
        onMouseDown={e => e.stopPropagation()}
        sx={{
          position: 'fixed',
          left: position.x,
          top: position.y - 45,
          display: 'flex',
          gap: 1,
          backgroundColor: 'background.surface',
          padding: 1,
          borderRadius: 'md',
          boxShadow: 'md',
          zIndex: 1000,
          transform: 'translateX(-50%)',
        }}
      >
        <Button size="sm" color="success" variant="soft" onClick={handleExplain} onMouseDown={e => e.stopPropagation()}>
          Explain
        </Button>
        <Button size="sm" color="warning" variant="soft" onClick={handleImprove} onMouseDown={e => e.stopPropagation()}>
          Improve
        </Button>
        <Button size="sm" color="secondary" variant="soft" onClick={handleQuote} onMouseDown={e => e.stopPropagation()}>
          Quote
        </Button>
        <Button
          size="sm"
          variant="soft"
          color="danger"
          onClick={handleCancelClick}
          onMouseDown={e => e.stopPropagation()}
          startDecorator={<Close />}
        >
          Cancel
        </Button>
      </Box>
    );
  }
);

FloatingButtons.displayName = 'FloatingButtons';

export default QuoteActions;
