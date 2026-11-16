import { useState } from 'react';
import { Alert } from '@mui/joy';
import type { AdminPermissionId } from '@bike4mind/common';
import { useAccessReviewDecision, type AccessReviewRow } from '@client/app/hooks/data/adminAccessReview';
import { ActionDialog } from '../shared';
import { useAdminUserPermissionsUpdate } from '../Users/Profile/actions/useAdminUserPermissionsUpdate';
import { useAdminUserRoleUpdate } from '../Users/Profile/actions/useAdminUserRoleUpdate';

const REASON_PRESETS = ['No longer needs admin access', 'Left the team', 'Dormant account'] as const;

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
  const [accessRemoved, setAccessRemoved] = useState(false);
  const [recordFailed, setRecordFailed] = useState(false);
  const updatePermissions = useAdminUserPermissionsUpdate(admin.userId);
  const updateRole = useAdminUserRoleUpdate(admin.userId);
  const decision = useAccessReviewDecision();
  const label = admin.email ?? admin.username ?? admin.userId;

  const removeAccess = async (reason: string) => {
    if (admin.fullAdmin) await updateRole({ isAdmin: false, reason });
    if (admin.directPermissions.length > 0 || admin.adminRoleIds.length > 0) {
      await updatePermissions({
        before: admin.directPermissions as AdminPermissionId[],
        adminPermissions: [],
        beforeAdminRoleIds: admin.adminRoleIds,
        adminRoleIds: [],
        reason,
      });
    }
  };

  // A rejection from the update hooks (already toasted, e.g. the last super admin) keeps the dialog open.
  const confirm = async (reason: string) => {
    if (!accessRemoved) {
      await removeAccess(reason);
      setAccessRemoved(true);
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
          ? 'This removes the Super Admin role and any delegated admin permissions.'
          : 'This removes every delegated admin permission and admin role.'
      }
      reasonPresets={REASON_PRESETS}
      reasonRequired={!accessRemoved}
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
          Access was removed, but the review did not record the decision. Retry to record it.
        </Alert>
      )}
    </ActionDialog>
  );
}
