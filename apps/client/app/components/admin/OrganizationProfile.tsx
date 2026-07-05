import React, { useState, useEffect, ChangeEvent, useRef } from 'react';
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
  styled,
} from '@mui/joy';
import { IOrganization, IOrganizationDocument, WithId } from '@bike4mind/common';
import GroupsIcon from '@mui/icons-material/Groups';
import SportsMartialArtsIcon from '@mui/icons-material/SportsMartialArts';
import ManageAccountsIcon from '@mui/icons-material/ManageAccounts';
import DownloadIcon from '@mui/icons-material/Download';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import LoginIcon from '@mui/icons-material/Login';
import { getLastLoginDate } from '@client/app/utils/user';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import Compressor from 'compressorjs';
import { getAppFileUrl } from '@client/app/utils/s3';
import { useConfig } from '@client/app/hooks/data/settings';
import { useUpdateOrganization } from '@client/app/hooks/data/organizations';
import { useUploadOrganizationLogo } from '@client/app/utils/organizationAPICalls';

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

const VisuallyHiddenInput = styled('input')`
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  bottom: 0;
  left: 0;
  white-space: nowrap;
  width: 1px;
`;

interface OrganizationProfileProps {
  org: WithId<IOrganizationDocument>;
  onClose: () => void;
  children?: React.ReactNode;
  activeDays: number;
}

const OrganizationProfile: React.FC<OrganizationProfileProps> = ({ org, onClose, children, activeDays }) => {
  const [editedOrg, setEditedOrg] = useState<WithId<IOrganization>>(org);

  const updateOrganizationMutation = useUpdateOrganization();
  const uploadLogoMutation = useUploadOrganizationLogo();
  const { data: config } = useConfig();
  const { appfileBucketName } = config || {};

  const logoInputRef = useRef<HTMLInputElement | null>(null);

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

  async function handleUploadLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const compressedFile = await compressLogo(file);

      await uploadLogoMutation.mutateAsync({
        organizationId: org.id,
        fileInfo: {
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        },
        file: compressedFile,
      });

      // Reset the file input
      if (logoInputRef.current) {
        logoInputRef.current.value = '';
      }
    } catch (error) {
      // Error is handled by the mutation hook
    }
  }

  return (
    <Sheet>
      <Stack spacing={2}>
        <Stack direction={'row'} justifyContent={'space-between'}>
          <Typography level="h4">{org.name} Profile</Typography>
          <Button onClick={onClose}>Close</Button>
        </Stack>

        <Grid container spacing={2}>
          <Grid xs={6}>
            <Stack direction={'row'} spacing={2}>
              <FormControl>
                <FormLabel>Logo</FormLabel>

                {org.logo && appfileBucketName && (
                  <div>
                    {}
                    <img src={getAppFileUrl({ key: org.logo.path })} alt={org.name} />
                  </div>
                )}

                <Button
                  component="label"
                  role={undefined}
                  tabIndex={-1}
                  startDecorator={<CloudUploadOutlinedIcon />}
                  sx={{ alignSelf: 'baseline' }}
                  loading={uploadLogoMutation.isPending}
                >
                  Upload a file
                  <VisuallyHiddenInput type="file" accept="image/*" onChange={handleUploadLogo} ref={logoInputRef} />
                </Button>
              </FormControl>
            </Stack>
            <Stack direction="column" spacing={2}>
              <Stack direction="row" spacing={2}>
                <FormControl>
                  <FormLabel>Customer Name</FormLabel>
                  <Input value={editedOrg.name} onChange={e => handleChange('name', e.target.value)} />
                </FormControl>
                <FormControl>
                  <FormLabel>Billing Contact</FormLabel>
                  <Input
                    value={editedOrg.billingContact}
                    onChange={e => handleChange('billingContact', e.target.value)}
                  />
                </FormControl>
              </Stack>
              <Stack direction="column" spacing={2}>
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

          <Grid xs={6}>
            <Stack direction="column" spacing={2}>
              <Card>
                <Grid container spacing={3} alignContent={'center'} justifyContent={'space-around'}>
                  <Grid xs={12}>
                    <Stack direction="row" spacing={2}>
                      <GroupsIcon />
                      <Typography level="body-xs">Total Users</Typography>
                      <Typography>
                        {totalUsers}/{org.seats}
                      </Typography>
                    </Stack>
                  </Grid>
                  <Grid xs={12}>
                    <Stack direction="row" spacing={2}>
                      <SportsMartialArtsIcon />
                      <Typography level="body-sm">Active Users</Typography>
                      <Typography>
                        {activeUsers}/{org.seats}
                      </Typography>
                    </Stack>
                  </Grid>
                  <Grid xs={12}>
                    <Stack direction="row" spacing={1}>
                      <LoginIcon />
                      <AccessTimeIcon />
                      <Typography level="body-sm">Last Login</Typography>
                      <Typography>{mostRecentLogin ? mostRecentLogin.toLocaleString() : '-'}</Typography>
                    </Stack>
                  </Grid>
                  <Grid xs={12}>
                    <Stack direction="row" spacing={1}>
                      <DownloadIcon />
                      <CalendarMonthIcon />
                      <Typography level="body-sm">Last Export</Typography>
                      <Typography>{mostRecentExport ? mostRecentExport.toLocaleString() : '-'}</Typography>
                    </Stack>
                  </Grid>
                </Grid>
              </Card>
              {children}

              <Stack spacing={1}>
                <Stack direction="row" spacing={2} justifyContent={'space-around'}>
                  <Typography level="h4">Users</Typography>
                  <FormControl orientation="horizontal">
                    <FormLabel>Total Seats</FormLabel>
                    <Input
                      type="number"
                      value={editedOrg.seats}
                      onChange={e => handleChange('seats', parseInt(e.target.value, 10))}
                    />
                  </FormControl>
                </Stack>
                {org.users?.map(({ user }, index) => (
                  <Card
                    key={index}
                    size="sm"
                    orientation="horizontal"
                    sx={{ bgcolor: index % 2 ? 'background.level1' : 'background.level2' }}
                  >
                    <Stack direction="row" spacing={2}>
                      <Typography>{user?.name}</Typography>
                      <Typography>{user?.email}</Typography>
                      <Typography>{user?.level}</Typography>
                      <Typography>{getLastLoginDate(user)?.toLocaleString() ?? '-'}</Typography>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            </Stack>
          </Grid>
        </Grid>
      </Stack>
    </Sheet>
  );
};

export default OrganizationProfile;
