import type { ReactNode } from 'react';
import { Button, Sheet, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';
export type AdminSelection = { mode: 'explicit'; ids: readonly string[] } | { mode: 'allMatching' };
export function BulkActionBar({
  selection,
  totalMatching,
  onSelectAllMatching,
  onClear,
  children,
}: {
  selection: AdminSelection;
  totalMatching: number;
  onSelectAllMatching: () => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const count = selection.mode === 'allMatching' ? totalMatching : selection.ids.length;
  if (count === 0) return null;
  return (
    <Sheet
      variant="outlined"
      data-testid="admin-bulk-action-bar"
      sx={{ ...adminSurface, position: 'sticky', bottom: 2, zIndex: 2, p: 2, boxShadow: 'md' }}
    >
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1}>
        <Typography sx={{ color: 'admin.ink' }}>{count.toLocaleString()} selected</Typography>
        {selection.mode === 'explicit' && count < totalMatching && (
          <Button variant="plain" size="sm" onClick={onSelectAllMatching} data-testid="admin-select-all-matching-btn">
            Select all {totalMatching.toLocaleString()} matching
          </Button>
        )}
        <Button variant="plain" size="sm" onClick={onClear} data-testid="admin-clear-selection-btn">
          Clear selection
        </Button>
        {children}
      </Stack>
    </Sheet>
  );
}
