import React, { useMemo, useState } from 'react';
import { Box, Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { useCancelSpaceInvite, useInviteToSpace, useSpaceInvites } from '@client/app/hooks/data/spaces';
import { buildPendingInviteRows } from '@client/app/components/organizations/pendingInviteRows';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Named invites by email, and the pending ones with a cancel. */
const SpaceInvitesTab: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const [email, setEmail] = useState('');
  const { data: invites, isError } = useSpaceInvites(spaceId);
  const invite = useInviteToSpace(spaceId);
  const cancel = useCancelSpaceInvite(spaceId);
  const rows = useMemo(() => buildPendingInviteRows(invites ?? []), [invites]);
  const trimmed = email.trim();
  const valid = EMAIL_PATTERN.test(trimmed);

  const handleSend = () => {
    if (!valid) return;
    invite.mutate(trimmed, {
      onSuccess: () => {
        setEmail('');
        toast.success('Invitation sent');
      },
    });
  };

  return (
    <Stack spacing={2} data-testid="space-invites-tab">
      <Stack direction="row" spacing={1} alignItems="flex-end">
        <FormControl size="sm" sx={{ flex: 1 }}>
          <FormLabel>Invite by email</FormLabel>
          <Input
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            slotProps={{ input: { 'data-testid': 'space-invite-email-input' } }}
          />
        </FormControl>
        <Button
          size="sm"
          disabled={!valid}
          loading={invite.isPending}
          onClick={handleSend}
          data-testid="space-invite-send-btn"
        >
          Send invite
        </Button>
      </Stack>
      {isError && <Typography color="danger">Pending invitations could not be loaded.</Typography>}
      {rows.length > 0 && (
        <Stack spacing={0.5} data-testid="space-pending-invites">
          <Typography level="title-sm">Pending invitations</Typography>
          {rows.map(row => (
            <Box key={row.key} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography level="body-sm" sx={{ flex: 1 }} noWrap>
                {row.label}
              </Typography>
              <Button
                size="sm"
                variant="plain"
                color="danger"
                loading={cancel.isPending && cancel.variables === row.inviteId}
                onClick={() => cancel.mutate(row.inviteId, { onSuccess: () => toast.success('Invitation cancelled') })}
                data-testid={`space-invite-cancel-${row.inviteId}`}
              >
                Cancel
              </Button>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
};

export default SpaceInvitesTab;
