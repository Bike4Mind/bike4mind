import React from 'react';
import { Avatar, Box, Button, Chip, Option, Select, Stack, Typography } from '@mui/joy';
import {
  useRemoveSpaceMember,
  useSetSpaceMemberRole,
  useTransferSpaceOwnership,
  type SpaceDetail,
  type SpacePerson,
} from '@client/app/hooks/data/spaces';
import { useConfirmation } from '@client/app/hooks/useConfirmation';

interface Props {
  space: SpaceDetail;
  currentUserId?: string;
}

const personLabel = (person: SpacePerson) => person.username || 'Unknown user';

/**
 * The roster. `email` is rendered only when the API sent one, which it does for managers alone, so a
 * plain member's view never carries addresses.
 */
const SpaceMembersTab: React.FC<Props> = ({ space, currentUserId }) => {
  const confirm = useConfirmation();
  const setRole = useSetSpaceMemberRole(space.id);
  const remove = useRemoveSpaceMember(space.id);
  const transfer = useTransferSpaceOwnership(space.id);
  const isOwner = space.viewerRole === 'owner';
  const isManager = isOwner || space.viewerRole === 'admin';
  const people = [space.owner, ...space.members.filter(m => m.userId !== space.owner.userId)];

  const canRemove = (person: SpacePerson) =>
    person.role !== 'owner' && person.userId !== currentUserId && (isOwner || (isManager && person.role === 'member'));

  const handleRemove = (person: SpacePerson) =>
    confirm({
      title: 'Remove member',
      description: `${personLabel(person)} will lose access to this space.`,
      type: 'danger',
      okLabel: 'Remove',
      onOk: async () => {
        await remove.mutateAsync(person.userId);
      },
    });

  const handleTransfer = (person: SpacePerson) =>
    confirm({
      title: 'Transfer ownership',
      description: `${personLabel(person)} becomes the owner and you become an admin.`,
      type: 'danger',
      okLabel: 'Transfer',
      onOk: async () => {
        await transfer.mutateAsync(person.userId);
      },
    });

  return (
    <Stack spacing={1} data-testid="space-members-list">
      {people.map(person => (
        <Box
          key={person.userId}
          data-testid={`space-member-row-${person.userId}`}
          sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', py: 0.5 }}
        >
          <Avatar size="sm" src={person.avatar ?? undefined} alt={personLabel(person)} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="title-sm" noWrap>
              {personLabel(person)}
            </Typography>
            {person.email && (
              <Typography level="body-xs" noWrap data-testid={`space-member-email-${person.userId}`}>
                {person.email}
              </Typography>
            )}
          </Box>
          {isOwner && person.role !== 'owner' ? (
            <Select
              size="sm"
              value={person.role}
              onChange={(_e, value) =>
                value && value !== person.role && setRole.mutate({ userId: person.userId, role: value })
              }
              slotProps={{ button: { 'data-testid': `space-member-role-${person.userId}`, 'aria-label': 'Role' } }}
            >
              <Option value="member">Member</Option>
              <Option value="admin">Admin</Option>
            </Select>
          ) : (
            <Chip size="sm" variant="soft" data-testid={`space-member-role-chip-${person.userId}`}>
              {person.role === 'owner' ? 'Owner' : person.role === 'admin' ? 'Admin' : 'Member'}
            </Chip>
          )}
          {isOwner && person.role === 'admin' && (
            <Button
              size="sm"
              variant="plain"
              onClick={() => handleTransfer(person)}
              data-testid={`space-member-transfer-${person.userId}`}
            >
              Make owner
            </Button>
          )}
          {canRemove(person) && (
            <Button
              size="sm"
              variant="plain"
              color="danger"
              onClick={() => handleRemove(person)}
              data-testid={`space-member-remove-${person.userId}`}
            >
              Remove
            </Button>
          )}
        </Box>
      ))}
    </Stack>
  );
};

export default SpaceMembersTab;
