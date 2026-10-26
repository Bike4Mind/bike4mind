import { hasAdminPermission } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { AdminPermissionBoundary } from '../../shared/AdminPermissionBoundary';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument, resolveUserStorageLimit, storageLimitToBytes, MAX_STORAGE_LIMIT_MB } from '@bike4mind/common';
import { computeStoragePercent } from '@client/app/components/admin/Users/Views/storageUtils';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import { CreditIcon } from '@client/app/components/svgs/icons/CreditIcon';
import SdStorageIcon from '@mui/icons-material/SdStorage';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import { Input, Stack, Tooltip, LinearProgress, Typography, Box, Button, Textarea, FormHelperText } from '@mui/joy';
import React, { useState } from 'react';
import prettyBytes from 'pretty-bytes';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';

interface Bike4MindUserDetailsProps {
  user: AdminUserListItem;
  userKey: string;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
  /** Optional reason for a manual credit change; recorded on the audit trail. */
  creditReason?: string;
  onCreditReasonChange?: (value: string) => void;
}

const Bike4MindUserDetails: React.FC<Bike4MindUserDetailsProps> = React.memo(
  ({ user, editedFields, onFieldChange, userKey, creditReason = '', onCreditReasonChange }) => {
    const currentUser = useUser(state => state.currentUser);
    const canManage = hasAdminPermission(currentUser, 'settings:manage');
    const [isRecalculating, setIsRecalculating] = useState(false);
    const queryClient = useQueryClient();
    const storage = resolveUserStorageLimit(user);
    const storagePercent = computeStoragePercent(user.currentStorageSize, storage.limitMb);

    const handleSubscribedDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newDate = e.target.value;
      onFieldChange('subscribedUntil', newDate);
    };

    const handleRecalculateStorage = async () => {
      if (!canManage) return;
      setIsRecalculating(true);
      try {
        await api.post(`/api/users/${user.id}/recalculate-storage`);
        queryClient.invalidateQueries({ queryKey: ['users'] });
        queryClient.invalidateQueries({ queryKey: ['user', user.id] });
      } catch (error) {
        console.error('Failed to recalculate storage:', error);
      } finally {
        setIsRecalculating(false);
      }
    };

    const handleReferralAvailableChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10) || 0;
      onFieldChange('numReferralsAvailable', newValue);
    };

    const handleCreditsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10) || 0;
      onFieldChange('currentCredits', newValue);
    };

    const handleStorageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.value === '') return;
      const newValue = Number(e.target.value);
      if (Number.isFinite(newValue) && newValue >= 0 && newValue <= MAX_STORAGE_LIMIT_MB) {
        onFieldChange('storageLimitOverride', newValue);
      }
    };

    const handleCreditsKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentValue = parseInt(e.currentTarget.value, 10) || 0;
        const newValue = e.key === 'ArrowUp' ? currentValue + 50 : Math.max(currentValue - 50, 0);
        handleCreditsChange({ target: { value: newValue.toString() } } as React.ChangeEvent<HTMLInputElement>);
      }
    };

    return (
      <Stack spacing={1}>
        <Tooltip title="Subscribed Until">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
            <WorkspacePremiumIcon />
            <Input
              disabled={!canManage}
              key={`subscribed-until-${userKey}`}
              type="date"
              size="sm"
              color={!user.subscribedUntil ? 'warning' : 'success'}
              value={user.subscribedUntil ? user.subscribedUntil.toString().split('T')[0] : ''}
              onChange={handleSubscribedDateChange}
              sx={{
                flex: 1,
                height: '36px',
              }}
            />
          </Stack>
        </Tooltip>

        <Tooltip title="Referrals">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
            <GroupAddIcon sx={{ width: '24px', pl: 0.24 }} />
            <Input
              disabled={!canManage}
              key={`referrals-${userKey}`}
              size="sm"
              type="number"
              value={user.numReferralsAvailable || 0}
              onChange={handleReferralAvailableChange}
              sx={{
                flex: 1,
                height: '36px',
              }}
            />
          </Stack>
        </Tooltip>

        <AdminPermissionBoundary permission="credits:adjust">
          <Tooltip title="Credits">
            <Stack
              direction="row"
              spacing={2}
              sx={{ alignItems: 'center', padding: '0px 16px 0px 8px', width: '100%' }}
            >
              <CreditIcon />
              <Input
                key={`credits-${userKey}`}
                sx={{
                  borderColor: editedFields?.currentCredits ? 'danger.500' : 'default',
                  flex: 1,
                }}
                type="number"
                value={user.currentCredits}
                onChange={handleCreditsChange}
                onKeyDown={handleCreditsKeyDown}
                slotProps={{
                  input: {
                    step: 50,
                  },
                }}
              />
            </Stack>
          </Tooltip>
        </AdminPermissionBoundary>
        {/* Reason surfaces only once credits are edited - it applies to that change. */}
        {editedFields?.currentCredits && onCreditReasonChange && (
          <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', padding: '0px 16px 0px 8px' }}>
            <Box sx={{ width: 24 }} />
            <Box sx={{ flex: 1 }}>
              <Textarea
                data-testid="admin-credit-reason-input"
                minRows={2}
                maxRows={4}
                placeholder="Reason for credit adjustment (required, min 5 characters)"
                value={creditReason}
                onChange={e => onCreditReasonChange(e.target.value)}
              />
              <FormHelperText>Required to save. Recorded on the credit audit trail.</FormHelperText>
            </Box>
          </Stack>
        )}
        <Tooltip title="Storage Usage">
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
              <SdStorageIcon />
              <Box sx={{ flex: 1 }}>
                <LinearProgress
                  data-testid="admin-user-storage-progress"
                  determinate
                  thickness={32}
                  value={storagePercent}
                  sx={{
                    '--LinearProgress-progressThickness': '26px',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    height: '28px',
                    backgroundColor: 'background.level2',
                  }}
                  color={storagePercent >= 90 ? 'danger' : storagePercent >= 75 ? 'warning' : 'primary'}
                >
                  <Typography
                    data-testid="admin-user-storage-label"
                    level="body-xs"
                    sx={{
                      mixBlendMode: 'normal',
                      color: 'text.primary',
                      fontWeight: 500,
                      zIndex: 2,
                    }}
                  >
                    {prettyBytes(user.currentStorageSize || 0)} / {prettyBytes(storageLimitToBytes(storage.limitMb))}
                  </Typography>
                </LinearProgress>
              </Box>
            </Stack>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
              <Box sx={{ width: 24 }} />
              <Input
                disabled={!canManage}
                key={`storage-limit-${userKey}`}
                sx={{
                  borderColor: editedFields?.storageLimitOverride ? 'danger.500' : 'default',
                  flex: 1,
                }}
                size="sm"
                type="number"
                data-testid="admin-user-storage-override-input"
                value={storage.limitMb}
                onChange={handleStorageChange}
                endDecorator={
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    MB limit
                  </Typography>
                }
              />
            </Stack>
            <Stack direction="row" spacing={1} sx={{ px: 2, alignItems: 'center' }}>
              <Typography data-testid="admin-user-storage-source" level="body-xs">
                Source: {storage.source}
              </Typography>
              {storage.source === 'override' && (
                <Button
                  disabled={!canManage}
                  data-testid="admin-user-storage-override-reset"
                  size="sm"
                  variant="plain"
                  onClick={() => onFieldChange('storageLimitOverride', null)}
                >
                  Clear override
                </Button>
              )}
            </Stack>
            <Box sx={{ padding: '0px 16px 0px 8px' }}>
              <Button
                disabled={!canManage}
                size="sm"
                variant="soft"
                color="primary"
                fullWidth
                loading={isRecalculating}
                onClick={handleRecalculateStorage}
              >
                Recalculate Storage Usage
              </Button>
            </Box>
          </Stack>
        </Tooltip>
      </Stack>
    );
  }
);

Bike4MindUserDetails.displayName = 'Bike4MindUserDetails';

export default Bike4MindUserDetails;
