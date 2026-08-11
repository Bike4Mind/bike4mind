import { useEffect, useRef, useState } from 'react';
import { Tooltip, Typography } from '@mui/joy';

interface TreeRowLabelProps {
  /** The row's name. Rendered clipped, and shown whole in a tooltip once it no longer fits. */
  label: string;
}

/**
 * A tree row's name with a tooltip that appears only when the text is actually clipped -
 * measured rather than guessed, since the rail's width, the row's actions and the font all vary.
 * Mirrors the sidebar's session rows (Session/SidenavItem), down to the followCursor placement,
 * so a long name behaves the same in both lists. Lives in its own component because the rows are
 * built inside a render callback, where per-row hooks are not an option.
 */
export default function TreeRowLabel({ label }: TreeRowLabelProps) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isClipped, setIsClipped] = useState(false);

  useEffect(() => {
    const measure = () => {
      const el = textRef.current;
      if (el) setIsClipped(el.scrollWidth > el.clientWidth);
    };
    measure();
    // The rail keeps its width, but the window's own resize reflows the row.
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [label]);

  return (
    <Tooltip title={isClipped ? label : ''} followCursor sx={{ zIndex: 10001 }}>
      <Typography ref={textRef} noWrap sx={{ fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
        {label}
      </Typography>
    </Tooltip>
  );
}
