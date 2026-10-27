import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument, resolveUserStorageLimit, storageLimitToBytes, MAX_STORAGE_LIMIT_MB } from '@bike4mind/common';
import { computeStoragePercent } from '@client/app/components/admin/Users/Views/storageUtils';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import { CreditIcon } from '@client/app/components/svgs/icons/CreditIcon';
import SdStorageIcon from '@mui/icons-material/SdStorage';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import { Input, Stack, Tooltip, LinearProgress, Typography, Box, Button, Textarea } from '@mui/joy';
import React, { useState } from 'react';
import prettyBytes from 'pretty-bytes';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';
import { AdjustCreditsDialog } from '../Profile/actions/AdjustCreditsDialog';
import { formatCredits } from '../Profile/actions/creditAdjustment';
import type { AdminUserProfile } from '../Profile/userProfileModel';

interface Bike4MindUserDetailsProps {
  user: AdminUserProfile;
  userKey: string;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

const Bike4MindUserDetails: React.FC<Bike4MindUserDetailsProps> = React.memo(
  ({ user, editedFields, onFieldChange, userKey }) => {
    const [isRecalculating, setIsRecalculating] = useState(false);
    const [unlockReason, setUnlockReason] = useState('');
    const [unlockError, setUnlockError] = useState('');
    const [unlockResult, setUnlockResult] = useState('');
    const [unlocking, setUnlocking] = useState(false);
    const [adjustCreditsOpen, setAdjustCreditsOpen] = useState(false);
    const queryClient = useQueryClient();
    const storage = resolveUserStorageLimit(user);
    const storagePercent = computeStoragePercent(user.currentStorageSize, storage.limitMb);

    const handleSubscribedDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newDate = e.target.value;
      onFieldChange('subscribedUntil', newDate);
    };

    const handleRecalculateStorage = async () => {
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

    const handleStorageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.value === '') return;
      const newValue = Number(e.target.value);
      if (Number.isFinite(newValue) && newValue >= 0 && newValue <= MAX_STORAGE_LIMIT_MB) {
        onFieldChange('storageLimitOverride', newValue);
      }
    };

    return (
      <Stack spacing={1}>
        <Typography level="body-sm" data-testid="admin-user-signup-grant">
          {user.signupGrant
            ? `Signup grant: ${user.signupGrant.stage}; released ${user.signupGrant.creditsReleased}; next: ${user.signupGrant.nextCondition ?? 'none'}`
            : 'Signup grant: not enrolled'}
        </Typography>
        {user.signupGrantAssessment && (
          <Typography level="body-sm" data-testid="admin-user-grant-assessment">
            Signup assessment: {user.signupGrantAssessment.band}; {user.signupGrantAssessment.status}; policy:{' '}
            {user.signupGrantAssessment.policyVersion ?? 'none'}; score: {user.signupGrantAssessment.score ?? 'n/a'}
          </Typography>
        )}
        {user.signupGrantAssessment &&
          (user.signupGrantAssessment.reasons.length > 0 || user.signupGrantAssessment.missing.length > 0) && (
            <Typography level="body-sm" data-testid="admin-user-grant-assessment-reasons">
              Matched: {user.signupGrantAssessment.reasons.join(', ') || 'none'}; missing:{' '}
              {user.signupGrantAssessment.missing.join(', ') || 'none'}
            </Typography>
          )}
        {user.signupGrant?.stage === 'signup' && (
          <Stack spacing={1}>
            <Textarea
              data-testid="admin-user-grant-reason-input"
              placeholder="Reason for signup grant unlock"
              value={unlockReason}
              onChange={event => setUnlockReason(event.target.value)}
            />
            <Button
              data-testid="admin-user-grant-unlock-btn"
              disabled={unlockReason.trim().length < 5}
              loading={unlocking}
              onClick={async () => {
                setUnlocking(true);
                setUnlockError('');
                setUnlockResult('');
                try {
                  const { data } = await api.post<{ creditsGranted?: number }>(
                    `/api/admin/users/${user.id}/unlock-signup-grant`,
                    { reason: unlockReason.trim() }
                  );
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['users'] }),
                    queryClient.invalidateQueries({ queryKey: ['user', user.id] }),
                  ]);
                  setUnlockReason('');
                  const granted = data?.creditsGranted ?? 0;
                  setUnlockResult(
                    granted > 0
                      ? `${granted.toLocaleString('en-US')} credits released.`
                      : 'No credits released. The account may be unverified, blocked, or already fully released.'
                  );
                } catch {
                  setUnlockError('Signup grant unlock failed. The account remains available for retry.');
                } finally {
                  setUnlocking(false);
                }
              }}
            >
              Unlock signup grant
            </Button>
            {unlockResult && (
              <Typography role="status" level="body-sm" data-testid="admin-user-grant-unlock-result">
                {unlockResult}
              </Typography>
            )}
            {unlockError && (
              <Typography color="danger" level="body-sm" data-testid="admin-user-grant-unlock-error">
                {unlockError}
              </Typography>
            )}
          </Stack>
        )}
        <Tooltip title="Subscribed Until">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
            <WorkspacePremiumIcon />
            <Input
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

        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px', width: '100%' }}>
          <CreditIcon />
          <Typography data-testid="user-card-credits-balance" level="body-md" sx={{ flex: 1 }}>
            {formatCredits(user.currentCredits ?? 0)}
          </Typography>
          <Button
            data-testid="user-card-adjust-credits-btn"
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={() => setAdjustCreditsOpen(true)}
          >
            Adjust credits
          </Button>
        </Stack>
        {adjustCreditsOpen && <AdjustCreditsDialog user={user} onClose={() => setAdjustCreditsOpen(false)} />}
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
