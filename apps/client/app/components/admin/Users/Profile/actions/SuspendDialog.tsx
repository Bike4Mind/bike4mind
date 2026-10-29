import React, { useState } from 'react';
import { Checkbox, Sheet, Typography } from '@mui/joy';
import { ActionDialog, ADMIN_REASON_PRESETS, undoAdminReason, useUndoToast } from '../../../shared';
import { formatCredits } from './creditAdjustment';
import { useAdminUserUpdate } from './useAdminUserUpdate';
import { BALANCE_REFRESH_FAILED, useRefreshedUser } from './useRefreshedUser';
import type { ProfileDialogProps } from './profileActions';
import { displayName } from '../userProfileModel';

/**
 * Suspend (DESIGN_GUIDE.md section 4, "changes access"). Suspending signs the user out everywhere;
 * the optional credit wipe rides the same request so both land or neither does. Undo reinstates and
 * gives back exactly the credits it removed.
 */
export const SuspendDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const { refreshing, failed: refreshFailed } = useRefreshedUser(user.id);
  const balance = user.currentCredits ?? 0;
  const [zeroCredits, setZeroCredits] = useState(false);
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();
  const name = displayName(user);

  const handleConfirm = async (reason: string) => {
    const removed = zeroCredits && balance > 0 ? balance : 0;
    await update({
      isBanned: true,
      statusChangeReason: reason,
      ...(removed > 0 && { currentCredits: 0, creditReason: reason }),
    });
    onClose();
    showUndo({
      message: removed > 0 ? `Account suspended, credits set to 0` : 'Account suspended',
      onUndo: () =>
        update({
          isBanned: false,
          statusChangeReason: undoAdminReason(reason),
          ...(removed > 0 && { creditDelta: removed, creditReason: undoAdminReason(reason) }),
        }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Suspend ${name}?`}
      description="They are signed out everywhere and cannot sign in until reinstated. Their data is kept."
      reasonPresets={ADMIN_REASON_PRESETS.suspension}
      confirmLabel="Suspend account"
      tone="danger"
      // Suspending alone needs no balance; only the wipe and its refund do.
      blockedReason={zeroCredits && refreshFailed ? BALANCE_REFRESH_FAILED : null}
      pending={refreshing}
      onConfirm={handleConfirm}
      data-testid="suspend-dialog"
    >
      {balance > 0 && (
        <Sheet
          variant="outlined"
          sx={{ p: 1.5, borderRadius: 'md', bgcolor: 'admin.surface', borderColor: 'admin.border' }}
        >
          <Checkbox
            checked={zeroCredits}
            onChange={event => setZeroCredits(event.target.checked)}
            label="Also set credits to 0"
            slotProps={{ input: { 'data-testid': 'suspend-dialog-zero-credits-checkbox' } }}
            sx={{ fontWeight: 500 }}
          />
          <Typography level="body-sm" sx={{ pl: 3.5, color: 'admin.inkMuted' }}>
            Removes {formatCredits(balance)} credits.
          </Typography>
        </Sheet>
      )}
    </ActionDialog>
  );
};

/** The reverse of SuspendDialog. Credits a suspension wiped stay wiped; adjust them separately. */
export const ReinstateDialog: React.FC<ProfileDialogProps> = ({ user, onClose, onAudit }) => {
  const update = useAdminUserUpdate(user.id);
  const showUndo = useUndoToast();

  const handleConfirm = async (reason: string) => {
    await update({ isBanned: false, statusChangeReason: reason });
    onClose();
    showUndo({
      message: 'Account reinstated',
      onUndo: () => update({ isBanned: true, statusChangeReason: undoAdminReason(reason) }),
      onViewAudit: onAudit,
    });
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Reinstate ${displayName(user)}?`}
      description="They can sign in again right away."
      reasonPresets={ADMIN_REASON_PRESETS.reinstatement}
      confirmLabel="Reinstate account"
      onConfirm={handleConfirm}
      data-testid="reinstate-dialog"
    />
  );
};
