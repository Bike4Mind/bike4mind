import { FC, useMemo, useState } from 'react';
import {
  Autocomplete,
  Card,
  Chip,
  ChipDelete,
  FormControl,
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
  unassignGroupMember,
} from '@client/app/utils/groupsAPICalls';
import { getErrorMessage, sanitizeErrorMessage } from '@client/app/utils/error';

interface OrganizationGroupsListProps {
  organization: WithId<IOrganizationDocument>;
}

/**
 * Shared groups-with-members surface (org-groups #1172). Lists an org's provisioned group instances
 * and lets an authorized viewer rename them and assign/unassign members. Consumed both on the
 * customer org page (via OrganizationGroups, beside the admins editor) and in the platform Admin ->
 * Organizations panel (via OrganizationGroupMembersCard, #1417). Assignment is scoped to org
 * members; the write-path invariant is enforced server-side, so this component assumes the caller
 * has already gated visibility.
 */
export const OrganizationGroupsList: FC<OrganizationGroupsListProps> = ({ organization }) => {
  const queryClient = useQueryClient();
  const orgId = organization.id;

  const { data: members = [] } = useGetOrganizationUsers(orgId);
  const groupsQuery = useQuery({
    queryKey: ['organizations', orgId, 'groups'],
    queryFn: () => fetchOrganizationGroups(orgId),
    // Personal orgs cannot be granted group types (enforced server-side), so there is nothing to
    // fetch. The customer route never renders this for a personal org and the admin card returns
    // early for one; this guard keeps the component self-safe regardless of caller.
    enabled: !organization.personal,
  });

  // `useGetOrganizationUsers` returns organization.users PLUS the billing owner (getUsers pushes
  // organization.userId), but the group-membership and admins routes both validate against
  // organization.users alone - the owner is deliberately not a member row. Offering the owner in
  // either picker therefore produces a server 400 ("not a member of this organization") on the
  // most natural first action. Filter to real member rows so the UI can only offer what the
  // server will accept.
  const assignableMembers = useMemo(
    () => members.filter(member => (organization.users ?? []).some(row => row.userId === member.id)),
    [members, organization.users]
  );

  const membersById = useMemo(() => {
    const map = new Map<string, IUserDocument>();
    members.forEach(member => map.set(member.id, member));
    return map;
  }, [members]);

  // Group membership lives only on the user document; the members endpoint serializes through
  // toSafeUser, which carries no `groups` field. So assign/unassign cannot change the members
  // response and only the groups query needs invalidating.
  const invalidateGroups = () => queryClient.invalidateQueries({ queryKey: ['organizations', orgId, 'groups'] });

  const renameMutation = useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) => renameOrganizationGroup(orgId, groupId, name),
    onSuccess: () => {
      invalidateGroups();
      toast.success('Group renamed');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  const assignMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) => assignGroupMember(orgId, groupId, userId),
    onSuccess: () => {
      invalidateGroups();
      toast.success('Member added to group');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  const unassignMutation = useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      unassignGroupMember(orgId, groupId, userId),
    onSuccess: () => {
      invalidateGroups();
      toast.success('Member removed from group');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });

  const groups = groupsQuery.data ?? [];

  return (
    <Stack spacing={1}>
      <Typography level="title-md" startDecorator={<GroupWorkOutlinedIcon fontSize="small" />}>
        Groups
      </Typography>
      {groupsQuery.isPending ? (
        <Typography level="body-sm" color="neutral" data-testid="org-groups-loading">
          Loading groups...
        </Typography>
      ) : groupsQuery.isError && !groupsQuery.data ? (
        // Distinct from the empty state on purpose: telling an org that already HAS groups to go
        // ask an administrator for group types is worse than saying nothing.
        // Gated on having no data: react-query reports isError for a failed REFETCH too, while
        // keeping the last good `data`. Without the guard a transient blip (or a focus refetch -
        // this query sets no staleTime) would replace a rendered roster with an error line and
        // strand the operator mid-task. With data in hand, keep showing it.
        <Typography level="body-sm" color="danger" data-testid="org-groups-error">
          Could not load groups. {sanitizeErrorMessage(getErrorMessage(groupsQuery.error))}
        </Typography>
      ) : groups.length === 0 ? (
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
            members={assignableMembers}
            onRename={name => renameMutation.mutate({ groupId: group.id, name })}
            onAssign={userId => assignMutation.mutate({ groupId: group.id, userId })}
            onUnassign={userId => unassignMutation.mutate({ groupId: group.id, userId })}
            isMutating={renameMutation.isPending || assignMutation.isPending || unassignMutation.isPending}
          />
        ))
      )}
    </Stack>
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
  // Memoized + Set-backed: `name` is local state in this component, so without this every
  // keystroke while renaming re-ran an O(members x memberIds) scan of the whole org.
  const assignable = useMemo(() => {
    const assigned = new Set(group.memberIds);
    return members.filter(member => !assigned.has(member.id));
  }, [members, group.memberIds]);

  // Re-seed from the prop on every entry to edit mode. `name` is initialized once and the card is
  // keyed on group.id, so it survives refetches: without this, a rename by another admin would
  // leave a stale value here that Enter would then commit, silently reverting their change.
  // NOTE this closes the pre-entry window only. If a concurrent rename lands while the editor is
  // already OPEN, the input still holds the older value and Enter still last-write-wins over it.
  // Closing that needs optimistic concurrency on the route (send the expected name, 409 on drift);
  // tracked separately rather than papered over with a mid-typing reset.
  const beginRename = () => {
    setName(group.name);
    setEditing(true);
  };

  const commitRename = () => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== group.name) onRename(trimmed);
    setEditing(false);
  };

  const cancelRename = () => {
    setName(group.name);
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
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') cancelRename();
                }}
                slotProps={{ input: { 'aria-label': `Rename group ${group.name}` } }}
                data-testid={`org-group-rename-input-${group.type}`}
                autoFocus
              />
              <IconButton
                size="sm"
                variant="soft"
                color="primary"
                aria-label={`Save new name for ${group.name}`}
                onClick={commitRename}
                data-testid={`org-group-rename-save-${group.type}`}
              >
                <CheckIcon />
              </IconButton>
              <IconButton
                size="sm"
                variant="plain"
                aria-label={`Cancel renaming ${group.name}`}
                onClick={cancelRename}
                data-testid={`org-group-rename-cancel-${group.type}`}
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
                aria-label={`Rename group ${group.name}`}
                onClick={beginRename}
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
              // A member id with no matching org member means a stale user.groups entry (a purge
              // that missed). Show that plainly rather than a bare ObjectId.
              const label = member?.name || member?.email || 'Unknown member';
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
                      aria-label={`Remove ${label} from ${group.name}`}
                      onClick={() => onUnassign(userId)}
                      data-testid={`org-group-unassign-${group.type}-${userId}`}
                    >
                      <CloseIcon fontSize="small" />
                    </ChipDelete>
                  }
                >
                  {label}
                </Chip>
              );
            })
          )}
        </Stack>

        <FormControl>
          <FormLabel>{`Add a member to ${group.name}`}</FormLabel>
          <Autocomplete
            options={assignable}
            value={null}
            getOptionLabel={member => member.name || member.email || member.id}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            placeholder="Search members"
            onChange={(_event, value) => value && onAssign(value.id)}
            data-testid={`org-group-assign-input-${group.type}`}
          />
        </FormControl>
      </Stack>
    </Card>
  );
};
