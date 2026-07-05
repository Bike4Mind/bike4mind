import React, { useState, useEffect } from 'react';
import {
  Sheet,
  Card,
  Stack,
  Grid,
  FormControl,
  Button,
  Textarea,
  Tooltip,
  FormLabel,
  Typography,
  Input,
} from '@mui/joy';
import { IOrganization, IOrganizationDocument, WithId } from '@bike4mind/common';
import GroupsIcon from '@mui/icons-material/Groups';
import SportsMartialArtsIcon from '@mui/icons-material/SportsMartialArts';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import LoginIcon from '@mui/icons-material/Login';
import { getLastLoginDate } from '@client/app/utils/user';
import Compressor from 'compressorjs';
import { useUpdateOrganization } from '@client/app/hooks/data/organizations';

export async function compressLogo(file: File, quality: number = 0.8): Promise<File | Blob> {
  return new Promise((resolve, reject) => {
    new Compressor(file, {
      quality,
      maxWidth: 100,
      maxHeight: 20,
      success(blob) {
        resolve(blob);
      },
      error(err) {
        reject(err);
      },
    });
  });
}

interface OrganizationProfileProps {
  org: WithId<IOrganizationDocument>;
  onClose: () => void;
  children?: React.ReactNode;
  activeDays: number;
}

const OrganizationProfileUpdated: React.FC<OrganizationProfileProps> = ({ org, onClose, children, activeDays }) => {
  const [editedOrg, setEditedOrg] = useState<WithId<IOrganization>>(org);

  const updateOrganizationMutation = useUpdateOrganization();

  const totalUsers = org.users?.length || 0;

  const activeUsers =
    org.users?.filter(({ user }) => {
      const lastLoginDate = getLastLoginDate(user);
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - activeDays);
      return lastLoginDate && lastLoginDate >= thresholdDate;
    }).length || 0;

  const managers = org.users?.filter(({ user }) => user?.level === 'ManagerUser' || user?.level === 'AdminUser') || [];

  const handleChange = (field: keyof IOrganizationDocument, value: any) => {
    setEditedOrg(prev => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    setEditedOrg({
      ...org,
      description: org.description ?? '',
      billingContact: org.billingContact ?? '',
    });
  }, [org]);

  const handleUpdate = async () => {
    try {
      await updateOrganizationMutation.mutateAsync({
        orgId: org.id,
        data: {
          name: editedOrg.name,
          billingContact: editedOrg.billingContact,
          description: editedOrg.description,
          seats: editedOrg.seats,
          currentCredits: editedOrg.currentCredits,
        },
      });
    } catch (error) {
      // Error is handled by the mutation hook
    }
  };

  const mostRecentLogin = org.users
    ?.map(({ user }) => getLastLoginDate(user))
    .filter((lastLogin): lastLogin is Date => lastLogin !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const mostRecentExport = org.users
    ?.map(user => (user.extraData?.lastExportDate ? new Date(user.extraData?.lastExportDate) : null))
    .filter((lastExport): lastExport is Date => lastExport !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <Sheet>
      <Stack spacing={2}>
        <Stack direction={'row'} justifyContent={'space-between'}>
          <Typography level="h4">{org.name} Profile</Typography>
        </Stack>

        <Grid container spacing={2}>
          <Grid xs={12} sm={6}>
            <Stack direction="column" spacing={2}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Customer Name</FormLabel>
                  <Input value={editedOrg.name} onChange={e => handleChange('name', e.target.value)} />
                </FormControl>
                <FormControl sx={{ flex: 1 }}>
                  <FormLabel>Billing Contact</FormLabel>
                  <Input
                    value={editedOrg.billingContact}
                    onChange={e => handleChange('billingContact', e.target.value)}
                  />
                </FormControl>
              </Stack>
              <Stack direction="column" spacing={2}>
                <FormControl>
                  <FormLabel>Current Credits</FormLabel>
                  <Input
                    value={editedOrg.currentCredits ?? 0}
                    onChange={e => handleChange('currentCredits', e.target.value)}
                  />
                </FormControl>
                <FormControl>
                  <FormLabel>Description</FormLabel>
                  <Textarea
                    value={editedOrg.description}
                    minRows={3}
                    onChange={e => handleChange('description', e.target.value)}
                  />
                </FormControl>
              </Stack>
              <Tooltip title={managers.map(manager => manager.user?.name).join(', ')}>
                <Stack direction="row" spacing={1}>
                  <ManageAccountsIcon />
                  <Typography level="body-sm">Managers:</Typography>
                  <Typography textColor={managers.length > 0 ? 'primary' : 'danger.500'}>
                    {managers.length > 0
                      ? `${managers.map(manager => manager.user?.name).join(', ')}`
                      : '<none assigned>'}
                  </Typography>
                </Stack>
              </Tooltip>
            </Stack>
            <Stack direction="row" spacing={2} justifyContent={'space-between'} sx={{ paddingTop: '30px' }}>
              <Button variant="outlined" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={handleUpdate} loading={updateOrganizationMutation.isPending}>
                Update
              </Button>
            </Stack>
          </Grid>

          <Grid xs={12} sm={6}>
            <Card variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                <Typography level="title-md">Organization Statistics</Typography>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                  <Stack direction="row" spacing={1} alignItems="center">
                    <GroupsIcon fontSize="small" />
                    <Typography level="body-sm">Total Users:</Typography>
                  </Stack>
                  <Typography fontWeight="lg">{totalUsers}</Typography>
                </Stack>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                  <Stack direction="row" spacing={1} alignItems="center">
                    <SportsMartialArtsIcon fontSize="small" />
                    <Typography level="body-sm">Active ({activeDays}d):</Typography>
                  </Stack>
                  <Typography fontWeight="lg">{activeUsers}</Typography>
                </Stack>
                {mostRecentLogin && (
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <LoginIcon fontSize="small" />
                      <Typography level="body-sm">Last Login:</Typography>
                    </Stack>
                    <Typography level="body-sm">{mostRecentLogin.toLocaleDateString()}</Typography>
                  </Stack>
                )}
                {mostRecentExport && (
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <AccessTimeIcon fontSize="small" />
                      <Typography level="body-sm">Last Export:</Typography>
                    </Stack>
                    <Typography level="body-sm">{mostRecentExport.toLocaleDateString()}</Typography>
                  </Stack>
                )}
                {org.createdAt && (
                  <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between">
                    <Stack direction="row" spacing={1} alignItems="center">
                      <CalendarMonthIcon fontSize="small" />
                      <Typography level="body-sm">Created:</Typography>
                    </Stack>
                    <Typography level="body-sm">{new Date(org.createdAt).toLocaleDateString()}</Typography>
                  </Stack>
                )}
              </Stack>
            </Card>
            {children}
          </Grid>
        </Grid>
      </Stack>
    </Sheet>
  );
};

export default OrganizationProfileUpdated;
