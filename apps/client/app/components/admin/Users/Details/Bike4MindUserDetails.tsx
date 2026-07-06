import { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';
import { IUserDocument } from '@bike4mind/common';
import GroupAddIcon from '@mui/icons-material/GroupAdd';
import MonetizationOnIcon from '@mui/icons-material/MonetizationOn';
import SdStorageIcon from '@mui/icons-material/SdStorage';
import WorkspacePremiumIcon from '@mui/icons-material/WorkspacePremium';
import { Input, Stack, Tooltip, LinearProgress, Typography, Box, Button } from '@mui/joy';
import React, { useState } from 'react';
import prettyBytes from 'pretty-bytes';
import { api } from '@client/app/contexts/ApiContext';
import { useQueryClient } from '@tanstack/react-query';

interface Bike4MindUserDetailsProps {
  user: IUserDocument;
  userKey: string;
  editedFields: EditedFieldsState;
  onFieldChange: (fieldName: keyof IUserDocument, value: unknown) => void;
}

const Bike4MindUserDetails: React.FC<Bike4MindUserDetailsProps> = React.memo(
  ({ user, editedFields, onFieldChange, userKey }) => {
    const [isRecalculating, setIsRecalculating] = useState(false);
    const queryClient = useQueryClient();

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

    const handleCreditsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10) || 0;
      onFieldChange('currentCredits', newValue);
    };

    const handleStorageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = parseInt(e.target.value, 10) || 0;
      onFieldChange('storageLimit', newValue);
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

        <Tooltip title="Credits">
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px', width: '100%' }}>
            <MonetizationOnIcon />
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
        <Tooltip title="Storage Usage">
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
              <SdStorageIcon />
              <Box sx={{ flex: 1 }}>
                <LinearProgress
                  determinate
                  thickness={32}
                  value={(user.currentStorageSize / (user.storageLimit * 1024 * 1024)) * 100}
                  sx={{
                    '--LinearProgress-progressThickness': '26px',
                    borderRadius: '6px',
                    border: '1px solid',
                    borderColor: 'neutral.outlinedBorder',
                    height: '28px',
                    backgroundColor: 'background.level2',
                  }}
                  color={
                    (user.currentStorageSize / (user.storageLimit * 1024 * 1024)) * 100 >= 90
                      ? 'danger'
                      : (user.currentStorageSize / (user.storageLimit * 1024 * 1024)) * 100 >= 75
                        ? 'warning'
                        : 'primary'
                  }
                >
                  <Typography
                    level="body-xs"
                    sx={{
                      mixBlendMode: 'normal',
                      color: 'text.primary',
                      fontWeight: 500,
                      zIndex: 2,
                    }}
                  >
                    {prettyBytes(user.currentStorageSize || 0)} / {prettyBytes(user.storageLimit * 1024 * 1024)}
                  </Typography>
                </LinearProgress>
              </Box>
            </Stack>
            <Stack direction="row" spacing={2} sx={{ alignItems: 'center', padding: '0px 16px 0px 8px' }}>
              <Box sx={{ width: 24 }} />
              <Input
                key={`storage-limit-${userKey}`}
                sx={{
                  borderColor: editedFields?.storageLimit ? 'danger.500' : 'default',
                  flex: 1,
                }}
                size="sm"
                type="number"
                value={user.storageLimit}
                onChange={handleStorageChange}
                endDecorator={
                  <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                    MB limit
                  </Typography>
                }
              />
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
