import { FC, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  Chip,
  ChipDelete,
  FormControl,
  FormHelperText,
  FormLabel,
  IconButton,
  Input,
  Stack,
  Typography,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import GroupWorkOutlinedIcon from '@mui/icons-material/GroupWorkOutlined';
import { getGroupType, IOrganizationDocument, IUserDocument, WithId } from '@bike4mind/common';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import {
  assignGroupMember,
  fetchOrganizationGroups,
  GroupWithMembers,
  renameOrganizationGroup,
  setOrganizationAdmins,
  unassignGroupMember,
} from '@client/app/utils/groupsAPICalls';
import { extractApiError } from '@client/app/utils/extractApiError';

interface OrganizationGroupsProps {
  organization: WithId<IOrganizationDocument>;
  /** Billing owner or platform admin - only they may appoint/remove org admins. */
  canSetAdmins: boolean;
}

/**
 * Customer-side group management (org-groups #1172, Phase 5). Rendered only for a billing owner,
 * an appointed org admin, or a platform admin (the route gates the tab). Lets them rename group
 * instances, assign/unassign their own members, and - if a billing owner/platform admin - appoint
 * org admins. Assignment is scoped to org members; the write-path invariant is enforced server-side.
 */
const OrganizationGroups: FC<OrganizationGroupsProps> = ({ organization, canSetAdmins }) => {
  const queryClient = useQueryClient();
  const orgId = organization.id;

  const { data: members = [] } = useGetOrganizationUsers(orgId);
  const groupsQuery = useQuery({
    queryKey: ['organizations', orgId, 'groups'],
    queryFn: () => fetchOrganizationGroups(orgId),
  });

  const membersById = useMemo(() => {
    const map = new Map<string, IUserDocument>();
    members.forEach(member => map.set(member.id, member));
    return map;
  }, [members]);

  const invalidateGroups = () => queryClient.invalidateQueries({ queryKey: ['organizations', orgId, 'groups'] });
  const invalidateMembers = () => queryClient.invalidateQueries({ queryKey: ['users', 'organization', orgId] });

  const renameMutation = useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) => renameOrganizationGroup(orgId, groupId, name),
    onSuccess: () => {
      invalidateGroups();
      toast.success('Group renamed');
    },
    onError: error => toast.error(extractApiError(error)),
  });

  const assignMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) => assignGroupMember(orgId, groupId, userId),
    onSuccess: () => {
      invalidateGroups();
      invalidateMembers();
      toast.success('Member added to group');
    },
    onError: error => toast.error(extractApiError(error)),
  });

  const unassignMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      unassignGroupMember(orgId, groupId, userId),
    onSuccess: () => {
      invalidateGroups();
      invalidateMembers();
      toast.success('Member removed from group');
    },
    onError: error => toast.error(extractApiError(error)),
  });

  const adminsMutation = useMutation({
    mutationFn: (adminUserIds: string[]) => setOrganizationAdmins(orgId, adminUserIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] });
      queryClient.invalidateQueries({ queryKey: ['organizations', orgId] });
      toast.success('Organization admins updated');
    },
    onError: error => toast.error(extractApiError(error)),
  });

  const groups = groupsQuery.data ?? [];

  return (
    <Stack spacing={3} data-testid="org-groups-section">
      {canSetAdmins && (
        <OrgAdminsEditor organization={organization} members={members} adminsMutation={adminsMutation} />
      )}

      <Stack spacing={1}>
        <Typography level="title-md" startDecorator={<GroupWorkOutlinedIcon fontSize="small" />}>
          Groups
        </Typography>
        {groups.length === 0 ? (
          <Typography level="body-sm" color="neutral" data-testid="org-groups-empty">
            No group types have been granted to this organization yet. Contact your Bike4Mind administrator to enable
            them.
          </Typography>
        ) : (
          groups.map(group => (
            <GroupCard
              key={group.id}
              group={group}
              membersById={membersById}
              members={members}
              onRename={name => renameMutation.mutate({ groupId: group.id, name })}
              onAssign={userId => assignMutation.mutate({ groupId: group.id, userId })}
              onUnassign={userId => unassignMutation.mutate({ groupId: group.id, userId })}
              isMutating={renameMutation.isPending || assignMutation.isPending || unassignMutation.isPending}
            />
          ))
        )}
      </Stack>
    </Stack>
  );
};

/** Appoint/remove org admins (billing owner + platform admin only). */
const OrgAdminsEditor: FC<{
  organization: WithId<IOrganizationDocument>;
  members: IUserDocument[];
  adminsMutation: { mutate: (ids: string[]) => void; isPending: boolean };
}> = ({ organization, members, adminsMutation }) => {
  const [selected, setSelected] = useState<string[]>(organization.adminUserIds ?? []);

  const current = organization.adminUserIds ?? [];
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

/** A single group instance: rename, current members (unassign), and an assign picker. */
const GroupCard: FC<{
  group: GroupWithMembers;
  membersById: Map<string, IUserDocument>;
  members: IUserDocument[];
  onRename: (name: string) => void;
  onAssign: (userId: string) => void;
  onUnassign: (userId: string) => void;
  isMutating: boolean;
}> = ({ group, membersById, members, onRename, onAssign, onUnassign, isMutating }) => {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);

  const typeLabel = getGroupType(group.type)?.label ?? group.type;
  const assignable = members.filter(member => !group.memberIds.includes(member.id));

  const commitRename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== group.name) onRename(trimmed);
    setEditing(false);
  };

  return (
    <Card variant="outlined" sx={{ p: 2 }} data-testid={`org-group-card-${group.type}`}>
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" spacing={1} justifyContent="space-between">
          {editing ? (
            <Stack direction="row" spacing={1} alignItems="center" flex={1}>
              <Input
                size="sm"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && commitRename()}
                data-testid={`org-group-rename-input-${group.type}`}
                autoFocus
              />
              <IconButton
                size="sm"
                variant="soft"
                color="primary"
                onClick={commitRename}
                data-testid={`org-group-rename-save-${group.type}`}
              >
                <CheckIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                onClick={() => {
                  setName(group.name);
                  setEditing(false);
                }}
              >
                <CloseIcon />
              </IconButton>
            </Stack>
          ) : (
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography level="title-sm">{group.name}</Typography>
              <Chip size="sm" variant="soft">
                {typeLabel}
              </Chip>
              <IconButton
                size="sm"
                variant="plain"
                onClick={() => setEditing(true)}
                data-testid={`org-group-rename-btn-${group.type}`}
              >
                <EditIcon fontSize="small" />
              </IconButton>
            </Stack>
          )}
          <Typography level="body-xs" textColor="text.tertiary">
            {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {group.memberIds.length === 0 ? (
            <Typography level="body-sm" color="neutral">
              No members assigned.
            </Typography>
          ) : (
            group.memberIds.map(userId => {
              const member = membersById.get(userId);
              return (
                <Chip
                  key={userId}
                  variant="soft"
                  color="primary"
                  disabled={isMutating}
                  endDecorator={
                    // ChipDelete (not a bare IconButton) so the chip's own action layer doesn't
                    // intercept the pointer - a plain IconButton in the endDecorator is unclickable.
                    <ChipDelete
                      variant="plain"
                      color="danger"
                      onClick={() => onUnassign(userId)}
                      data-testid={`org-group-unassign-${group.type}-${userId}`}
                    >
                      <CloseIcon fontSize="small" />
                    </ChipDelete>
                  }
                >
                  {member?.name || member?.email || userId}
                </Chip>
              );
            })
          )}
        </Stack>

        <FormControl>
          <Autocomplete
            options={assignable}
            value={null}
            getOptionLabel={member => member.name || member.email || member.id}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            placeholder="Add a member to this group"
            onChange={(_event, value) => value && onAssign(value.id)}
            data-testid={`org-group-assign-input-${group.type}`}
          />
        </FormControl>
      </Stack>
    </Card>
  );
};

export default OrganizationGroups;
