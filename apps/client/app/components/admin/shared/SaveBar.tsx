import { useEffect, useRef } from 'react';
import { Button, Sheet, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';

export type SaveBarProps = {
  count: number;
  pending?: boolean;
  blockedReason?: string;
  error?: string;
  onSave(): void;
  onDiscard(): void;
};

export function SaveBar({ count, pending, blockedReason, error, onSave, onDiscard }: SaveBarProps) {
  const saveRef = useRef(onSave);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (count > 0 && !pending && !blockedReason) saveRef.current();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [count, pending, blockedReason]);

  if (count === 0) return null;
  return (
    <Sheet
      variant="outlined"
      data-testid="admin-save-bar"
      sx={{ ...adminSurface, position: 'sticky', bottom: 0, zIndex: 3, p: 2 }}
    >
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
        <Typography role="status" sx={{ flex: 1 }}>
          {count} unsaved change{count === 1 ? '' : 's'}
        </Typography>
        <Button variant="outlined" disabled={pending} onClick={onDiscard} data-testid="admin-save-discard-btn">
          Discard
        </Button>
        <Button
          disabled={Boolean(blockedReason)}
          loading={pending}
          onClick={onSave}
          data-testid="admin-save-confirm-btn"
        >
          Save (Cmd+S)
        </Button>
      </Stack>
      {(blockedReason || error) && (
        <Typography role="alert" level="body-sm">
          {blockedReason || error}
        </Typography>
      )}
    </Sheet>
  );
}
