import { useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton, Tooltip } from '@mui/joy';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';

type AnalyticsTermHelpProps = {
  term: string;
  description: ReactNode;
  testId?: string;
};

export function AnalyticsTermHelp({ term, description, testId }: AnalyticsTermHelpProps) {
  const [open, setOpen] = useState(false);
  // Set by a click, so a second click closes the help while a click after hover/focus-open keeps it.
  const pinned = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    pinned.current = false;
    setOpen(false);
  };

  // WebKit does not focus a tapped button, so blur never fires there; dismiss on a tap elsewhere.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return;
      pinned.current = false;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onClick = () => {
    if (open && pinned.current) return close();
    pinned.current = true;
    setOpen(true);
  };

  return (
    <Tooltip
      title={description}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={close}
      describeChild
      disableTouchListener
      sx={{ maxWidth: 300 }}
    >
      <IconButton
        ref={buttonRef}
        size="sm"
        variant="plain"
        color="neutral"
        aria-label={`About ${term}`}
        onClick={onClick}
        onFocus={() => setOpen(true)}
        onBlur={close}
        data-testid={testId}
        sx={{ verticalAlign: 'middle' }}
      >
        <HelpOutlineIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
