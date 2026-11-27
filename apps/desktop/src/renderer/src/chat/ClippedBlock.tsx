import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Button from '@mui/joy/Button';
import { ChevronIcon } from './icons';
import { thinScrollbarSx } from './layout';

/**
 * A block clipped to `maxHeight` that scrolls inside the clip, with an Expand / Collapse control
 * offered only when the content is taller than the clip.
 *
 * `measureKey` is what the content was drawn from (its text): a block already at its clip does
 * not change size as more streams in, so a resize alone would never notice it overflowing.
 */
export function ClippedBlock({
  maxHeight,
  measureKey,
  testId,
  revealKey = 0,
  children,
}: {
  /** In px. */
  maxHeight: number;
  measureKey: string;
  testId: string;
  /** Each new non-zero value expands the block: find landing on a match inside it. */
  revealKey?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    if (revealKey !== 0) setExpanded(true);
  }, [revealKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    // Expanded, nothing is clipped to measure against; the control has to stay to collapse it.
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, measureKey]);

  return (
    <>
      <Box
        ref={ref}
        id={id}
        sx={expanded ? undefined : { maxHeight, overflowY: 'auto', ...thinScrollbarSx }}
        data-testid={testId}
        data-expanded={expanded ? 'true' : 'false'}
      >
        {children}
      </Box>
      {overflows && (
        <Button
          size="sm"
          variant="plain"
          color="neutral"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(value => !value)}
          endDecorator={<ChevronIcon open={expanded} />}
          sx={{ minHeight: 0, px: 0.75, py: 0, mt: 0.25, fontSize: 'xs', fontWeight: 'md' }}
          data-testid={`${testId}-toggle`}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </Button>
      )}
    </>
  );
}
