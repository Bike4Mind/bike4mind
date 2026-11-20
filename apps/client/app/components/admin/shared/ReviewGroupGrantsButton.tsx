import { useState } from 'react';
import { Button, Typography, Stack } from '@mui/joy';
import { useUser } from '@client/app/contexts/UserContext';
import { hasAdminPermission } from '@bike4mind/common';
import { PendingBulkDialog } from '../InviteCenter/Pending/PendingBulkDialog';
import { MAX_PENDING_BULK } from '../InviteCenter/Pending/usePendingBulkActions';

/** Opens the existing audited preview; no grants change until the admin confirms. */
export function ReviewGroupGrantsButton({ userIds, incomplete }: { userIds: readonly string[]; incomplete?: boolean }) {
  const [open, setOpen] = useState(false);
  const { currentUser } = useUser();
  if (!currentUser || !hasAdminPermission(currentUser, 'credits:adjust')) return null;
  const ids = [...new Set(userIds)];
  if (!ids.length || ids.length > MAX_PENDING_BULK || incomplete) return null;
  return (
    <Stack gap={0.5}>
      <Button
        size="sm"
        color="neutral"
        variant="outlined"
        data-testid="review-group-grants-btn"
        onClick={() => setOpen(true)}
      >
        Review blocking future grants
      </Button>
      <Typography level="body-xs">
        Manual action with a preview and audit reason. Existing credits stay usable; account access is unchanged.
      </Typography>
      {open && <PendingBulkDialog kind="block" userIds={ids} onClose={() => setOpen(false)} onDone={() => undefined} />}
    </Stack>
  );
}
