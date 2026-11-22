import { useState } from 'react';
import { Alert } from '@mui/joy';
import { useAccessReviewDecision, type AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { ActionDialog } from '../shared';
import { useAdminUserPermissionsUpdate } from '../Users/Profile/actions/useAdminUserPermissionsUpdate';
import { useAdminUserRoleUpdate } from '../Users/Profile/actions/useAdminUserRoleUpdate';
import { isUncertainFailure, permissionsRemoval } from './revokeAdminAccess';

export const REVOKE_REASON_PRESETS = ['No longer needs admin access', 'Left the team', 'Dormant account'] as const;

type RevokeAccessDialogProps = {
  admin: AccessReviewRow;
  dormantDays: number;
  onClose: () => void;
};

/**
 * Removes the admin's access through the existing audited role/permission routes, then records the
 * decision. The decision route refuses a revoke while any access remains, so the order is fixed.
 */
export function RevokeAccessDialog({ admin, dormantDays, onClose }: RevokeAccessDialogProps) {
  const [removalState, setRemovalState] = useState<'pending' | 'uncertain' | 'removed'>('pending');
  const [recordFailed, setRecordFailed] = useState(false);
  const updatePermissions = useAdminUserPermissionsUpdate(admin.userId);
  const updateRole = useAdminUserRoleUpdate(admin.userId);
  const decision = useAccessReviewDecision();
  const label = admin.email ?? admin.username ?? admin.userId;
  const roleNames = admin.roles.map(role => role.name ?? 'a deleted role');
  const rolesNote = roleNames.length > 0 ? ` Roles removed: ${roleNames.join(', ')}.` : '';

  const removeAccess = async (reason: string) => {
    if (admin.fullAdmin) await updateRole({ isAdmin: false, reason });
    const removal = permissionsRemoval(admin, reason);
    if (removal) await updatePermissions(removal);
  };

  // A rejection from the update hooks (already toasted, e.g. the last super admin) keeps the dialog open.
  const confirm = async (reason: string) => {
    if (removalState === 'pending') {
      try {
        await removeAccess(reason);
        setRemovalState('removed');
      } catch (error) {
        // A lost response can follow a committed removal. Never replay its stale permission CAS.
        if (isUncertainFailure(error)) {
          setRemovalState('uncertain');
          setRecordFailed(true);
        }
        throw error;
      }
    }
    try {
      await decision.mutateAsync({ userId: admin.userId, decision: 'revoked', dormantDays });
      onClose();
    } catch (error) {
      setRecordFailed(true);
      throw error;
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Revoke admin access for ${label}`}
      description={
        admin.fullAdmin
          ? `This removes the Super Admin role and any delegated admin permissions.${rolesNote}`
          : `This removes every delegated admin permission and admin role.${rolesNote}`
      }
      reasonPresets={REVOKE_REASON_PRESETS}
      reasonRequired={removalState === 'pending'}
      confirmLabel={recordFailed ? 'Retry recording' : 'Revoke access'}
      onConfirm={confirm}
      tone="danger"
      data-testid="admin-access-review-revoke-dialog"
      testIds={{
        reason: 'admin-access-review-revoke-reason-input',
        confirm: recordFailed ? 'admin-access-review-revoke-retry-btn' : 'admin-access-review-revoke-confirm-btn',
      }}
    >
      {recordFailed && (
        <Alert color="warning" data-testid="admin-access-review-revoke-retry">
          {removalState === 'uncertain'
            ? 'The access change could not be confirmed. Retry to check the server and record it if access was removed. If access remains, close this dialog and review the refreshed account before trying again.'
            : 'Access was removed, but the review did not record the decision. Retry to record it.'}
        </Alert>
      )}
    </ActionDialog>
  );
}
