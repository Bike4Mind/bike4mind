import { FC, useMemo, useState } from 'react';
import { Autocomplete, Box, Button, Card, FormControl, FormHelperText, FormLabel, Stack, Typography } from '@mui/joy';
import { IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import { setOrganizationAdmins } from '@client/app/utils/groupsAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { OrganizationGroupsList } from './OrganizationGroupsList';

interface OrganizationGroupsProps {
  organization: WithId<IOrganizationDocument>;
  /** Billing owner or platform admin - only they may appoint/remove org admins. */
  canSetAdmins: boolean;
}

/**
 * Customer-side group management (org-groups #1172, Phase 5). Rendered only for a billing owner,
 * an appointed org admin, or a platform admin (the route gates the tab). Lets them appoint org
 * admins (billing owner/platform admin only) and manage group members via the shared
 * OrganizationGroupsList. Assignment is scoped to org members; the write-path invariant is enforced
 * server-side.
 */
const OrganizationGroups: FC<OrganizationGroupsProps> = ({ organization, canSetAdmins }) => {
  const queryClient = useQueryClient();
  const orgId = organization.id;

  const { data: members = [] } = useGetOrganizationUsers(orgId);

  // The admins route validates against organization.users alone (the billing owner is never a
  // member row), so the picker must offer only real members or the owner would 400. Mirrors the
  // filter the shared list applies to its assign picker.
  const assignableMembers = useMemo(
    () => members.filter(member => (organization.users ?? []).some(row => row.userId === member.id)),
    [members, organization.users]
  );

  const adminsMutation = useMutation({
    mutationFn: (adminUserIds: string[]) => setOrganizationAdmins(orgId, adminUserIds),
    onSuccess: () => {
      // Prefix match - this already covers ['organizations', orgId] and its 'groups' child.
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      toast.success('Organization admins updated');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  return (
    <Stack spacing={3} data-testid="org-groups-section">
      {canSetAdmins && (
        <OrgAdminsEditor organization={organization} members={assignableMembers} adminsMutation={adminsMutation} />
      )}

      <OrganizationGroupsList organization={organization} />
    </Stack>
  );
};

/** Appoint/remove org admins (billing owner + platform admin only). */
const OrgAdminsEditor: FC<{
  organization: WithId<IOrganizationDocument>;
  members: IUserDocument[];
  adminsMutation: { mutate: (ids: string[]) => void; isPending: boolean };
}> = ({ organization, members, adminsMutation }) => {
  const current = organization.adminUserIds ?? [];
  const [selected, setSelected] = useState<string[]>(current);

  // Resync when the persisted set changes underneath us. PUT /admins is a FULL REPLACE, so without
  // this a stale `selected` would (a) display the wrong roster and (b) mark itself dirty on its
  // own - one click then silently de-appoints whoever was added elsewhere. Adjust-during-render
  // rather than an effect so the first paint after a refetch is already correct.
  const currentKey = [...current].sort().join(',');
  const [syncedKey, setSyncedKey] = useState(currentKey);
  if (currentKey !== syncedKey) {
    setSyncedKey(currentKey);
    setSelected(current);
  }

  const isDirty = selected.length !== current.length || selected.some(id => !current.includes(id));
  const selectedMembers = members.filter(member => selected.includes(member.id));

  return (
    <Card variant="outlined" sx={{ p: 2 }} data-testid="org-admins-card">
      <Stack spacing={1.5}>
        <Typography level="title-md">Organization Admins</Typography>
        <FormControl>
          <FormLabel>Appointed admins</FormLabel>
          <Autocomplete
            multiple
            options={members}
            value={selectedMembers}
            getOptionLabel={member => member.name || member.email || member.id}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            onChange={(_event, value) => setSelected(value.map(member => member.id))}
            placeholder={selectedMembers.length ? '' : 'Appoint org admins'}
            data-testid="org-admins-input"
          />
          <FormHelperText>
            Org admins manage groups and members without any platform-wide privilege. The billing owner is always an
            admin.
          </FormHelperText>
        </FormControl>
        <Box>
          <Button
            size="sm"
            onClick={() => adminsMutation.mutate(selected)}
            loading={adminsMutation.isPending}
            disabled={!isDirty}
            data-testid="org-admins-save-btn"
          >
            Save admins
          </Button>
        </Box>
      </Stack>
    </Card>
  );
};

export default OrganizationGroups;
