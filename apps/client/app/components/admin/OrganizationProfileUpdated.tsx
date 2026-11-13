import React, { useState, useEffect } from 'react';
import { Stack, Grid, FormControl, Button, Textarea, FormLabel, FormHelperText, Typography, Input } from '@mui/joy';
import { IOrganization, IOrganizationDocument, WithId } from '@bike4mind/common';
import { orgManagerNames } from './orgManagerNames';
import { getLastLoginDate } from '@client/app/utils/user';
import Compressor from 'compressorjs';
import { useUpdateOrganization } from '@client/app/hooks/data/organizations';
import OrganizationGroupTypesCard from './OrganizationGroupTypesCard';
import OrganizationGroupMembersCard from './OrganizationGroupMembersCard';
import OrganizationStorageLimitField, { parseStorageLimitInput } from './OrganizationStorageLimitField';
import { OrganizationBillingSection } from './Billing/OrganizationBillingSection';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  ChangePreview,
  EntityHeader,
  SectionCard,
  SettingsSection,
  StatStrip,
  StatTile,
  Fact,
  StatusChip,
} from './shared';

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
  const [storageLimitInput, setStorageLimitInput] = useState(org.storageLimit?.toString() ?? '');
  // The modal stays open after Update and `org` is the caller's snapshot, so track what was last saved.
  const [savedStorageLimit, setSavedStorageLimit] = useState(org.storageLimit ?? null);
  const parsedStorageLimit = parseStorageLimitInput(storageLimitInput);
  const [creditDialogOpen, setCreditDialogOpen] = useState(false);
  const [creditInput, setCreditInput] = useState(String(org.currentCredits ?? 0));
  const [savedCredits, setSavedCredits] = useState(org.currentCredits ?? 0);

  const updateOrganizationMutation = useUpdateOrganization();

  const totalUsers = org.users?.length || 0;

  const activeUsers =
    org.users?.filter(({ user }) => {
      const lastLoginDate = getLastLoginDate(user);
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - activeDays);
      return lastLoginDate && lastLoginDate >= thresholdDate;
    }).length || 0;

  // The org's own managers, not members whose platform-wide `level` happens to be Manager/Admin.
  const managerNames = orgManagerNames(org);

  const handleChange = (field: 'name' | 'description' | 'billingContact', value: string) => {
    setEditedOrg(prev => ({ ...prev, [field]: value }));
  };

  useEffect(() => {
    setEditedOrg({
      ...org,
      description: org.description ?? '',
      billingContact: org.billingContact ?? '',
    });
    setStorageLimitInput(org.storageLimit?.toString() ?? '');
    setSavedStorageLimit(org.storageLimit ?? null);
    setSavedCredits(org.currentCredits ?? 0);
    setCreditInput(String(org.currentCredits ?? 0));
  }, [org]);

  // The input holds a string while typing; an empty or non-numeric value ("1,000") is NaN.
  const rawCredits = creditInput.trim();
  const editedCredits = rawCredits === '' ? NaN : Number(rawCredits);
  const creditsValid = Number.isSafeInteger(editedCredits) && editedCredits >= 0;
  const creditsChanged = editedCredits !== savedCredits;

  const handleUpdate = async () => {
    if (!parsedStorageLimit.valid) return;
    // Send only a changed limit, so saving other fields never writes null onto an org that has no override.
    const storageLimitChanged = parsedStorageLimit.storageLimit !== savedStorageLimit;
    try {
      await updateOrganizationMutation.mutateAsync({
        orgId: org.id,
        data: {
          name: editedOrg.name,
          billingContact: editedOrg.billingContact,
          description: editedOrg.description,
          seats: editedOrg.seats,
          ...(storageLimitChanged && { storageLimit: parsedStorageLimit.storageLimit }),
        },
      });
      setSavedStorageLimit(parsedStorageLimit.storageLimit);
    } catch (error) {
      // Error is handled by the mutation hook
    }
  };

  const handleCreditsUpdate = async (reason: string) => {
    if (!creditsValid || !creditsChanged) return;
    try {
      const saved = await updateOrganizationMutation.mutateAsync({
        orgId: org.id,
        data: { currentCredits: editedCredits, creditReason: reason },
      });
      const committedCredits = saved.currentCredits ?? editedCredits;
      setSavedCredits(committedCredits);
      setCreditInput(String(committedCredits));
      setCreditDialogOpen(false);
    } catch {
      // The mutation reports failures.
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
    <Stack spacing={3}>
      <EntityHeader
        title={org.name}
        id={org.id}
        timestamp={org.createdAt ? String(org.createdAt) : undefined}
        status={<StatusChip tone="neutral" label={org.personal ? 'Personal' : 'Organization'} />}
      />
      <StatStrip aria-label="Organization statistics">
        <StatTile label="Total users" value={totalUsers} />
        <StatTile label={`Active (${activeDays}d)`} value={activeUsers} />
        <StatTile label="Credits" value={savedCredits} />
      </StatStrip>
      <Grid container spacing={2}>
        <Grid xs={12} sm={6}>
          <SettingsSection>
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
                <OrganizationStorageLimitField
                  orgId={org.id}
                  value={storageLimitInput}
                  onChange={setStorageLimitInput}
                />
                <FormControl>
                  <FormLabel>Description</FormLabel>
                  <Textarea
                    value={editedOrg.description}
                    minRows={3}
                    onChange={e => handleChange('description', e.target.value)}
                  />
                </FormControl>
              </Stack>
            </Stack>
            <Stack direction="row" spacing={2} justifyContent={'space-between'} sx={{ paddingTop: '30px' }}>
              <Button variant="outlined" onClick={onClose}>
                Cancel
              </Button>
              <Button
                data-testid="admin-org-update-btn"
                onClick={handleUpdate}
                loading={updateOrganizationMutation.isPending}
                disabled={!parsedStorageLimit.valid}
              >
                Update
              </Button>
            </Stack>
          </SettingsSection>
        </Grid>

        <Grid xs={12} sm={6}>
          <Stack spacing={2}>
            <SettingsSection>
              <Stack spacing={1}>
                <Typography level="title-md">Credits</Typography>
                <FormControl error={!creditsValid}>
                  <FormLabel>Current credits</FormLabel>
                  <Input
                    value={creditInput}
                    onChange={e => setCreditInput(e.target.value)}
                    slotProps={{ input: { 'data-testid': 'org-profile-credits-input' } }}
                  />
                  {!creditsValid && (
                    <FormHelperText data-testid="org-profile-credits-error">
                      Enter a whole number of credits (0 or more), without commas.
                    </FormHelperText>
                  )}
                </FormControl>
                <Button
                  variant="outlined"
                  disabled={!creditsChanged || !creditsValid}
                  onClick={() => setCreditDialogOpen(true)}
                  data-testid="org-profile-adjust-credits-btn"
                >
                  Adjust credits
                </Button>
              </Stack>
            </SettingsSection>
            <SectionCard title="Organization details">
              <Fact label="Managers">{managerNames.join(', ')}</Fact>
              <Fact label="Last login">{mostRecentLogin?.toLocaleDateString()}</Fact>
              <Fact label="Last export">{mostRecentExport?.toLocaleDateString()}</Fact>
              <Fact label="Created">{org.createdAt ? new Date(org.createdAt).toLocaleDateString() : undefined}</Fact>
            </SectionCard>
            <OrganizationGroupTypesCard org={org} />
            <OrganizationGroupMembersCard org={org} />
            {children}
          </Stack>
        </Grid>
      </Grid>
      <OrganizationBillingSection orgId={org.id} />
      <ActionDialog
        open={creditDialogOpen}
        onClose={() => setCreditDialogOpen(false)}
        title={`Adjust credits for ${org.name}`}
        reasonPresets={ADMIN_REASON_PRESETS.creditAdjustment}
        confirmLabel={`Set balance to ${creditsValid ? editedCredits.toLocaleString() : '0'}`}
        blockedReason={creditsValid && creditsChanged ? null : 'Enter a different balance of 0 or more.'}
        pending={updateOrganizationMutation.isPending}
        onConfirm={handleCreditsUpdate}
        data-testid="org-profile-credit-dialog"
        testIds={{ reason: 'org-profile-credit-reason-input' }}
      >
        <ChangePreview
          before={savedCredits.toLocaleString()}
          after={creditsValid ? editedCredits.toLocaleString() : '-'}
          data-testid="org-profile-credit-preview"
        />
      </ActionDialog>
    </Stack>
  );
};

export default OrganizationProfileUpdated;
