import { IInviteDocumentWithDetails, InviteType } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useAcceptDocument, useGetUserInvites, useRefuseDocument } from '@client/app/hooks/data/invites';
import { Box, Button, Card, Typography } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import { FC, useMemo, useState } from 'react';

/** Filters inbox invites down to the project invites still waiting on this user. */
export const selectPendingProjectInvites = (
  invites: IInviteDocumentWithDetails[] | undefined,
  email: string | null | undefined
): IInviteDocumentWithDetails[] =>
  (invites ?? []).filter(
    i =>
      i.type === InviteType.Project &&
      i.remaining > 0 &&
      !!email &&
      !!i.recipients?.pending?.some(p => p.toLowerCase() === email.toLowerCase())
  );

/**
 * Project invites otherwise live only in Profile > Inbox, so a new invitee lands on an empty
 * /projects page. Mirrors the inbox Accept/Decline (components/inbox/Invites.tsx).
 */
const PendingProjectInvites: FC = () => {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const invitesQuery = useGetUserInvites(currentUser?.id ?? '');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [handled, setHandled] = useState<string[]>([]);

  const settle = () => setBusyId(null);
  // Buttons are disabled while a response is in flight, so the last handled id is the one that failed.
  const acceptInvite = useAcceptDocument({
    onSuccess: () => queryClient.refetchQueries({ queryKey: ['projects', 'search'] }),
    onSettled: settle,
    onError: () => setHandled(prev => prev.slice(0, -1)),
  });
  const refuseInvite = useRefuseDocument({
    onSettled: settle,
    onError: () => setHandled(prev => prev.slice(0, -1)),
  });

  const pending = useMemo(
    () => selectPendingProjectInvites(invitesQuery.data, currentUser?.email).filter(i => !handled.includes(i.id)),
    [invitesQuery.data, currentUser?.email, handled]
  );

  if (pending.length === 0) return null;

  const respond = (invite: IInviteDocumentWithDetails, accept: boolean) => {
    setBusyId(invite.id);
    setHandled(prev => [...prev, invite.id]);
    (accept ? acceptInvite : refuseInvite).mutate(invite.id);
  };

  return (
    <Box data-testid="projects-pending-invites" display="flex" flexDirection="column" gap={1.5}>
      <Typography level="title-md">Pending invitations</Typography>
      {pending.map(invite => (
        <Card
          key={invite.id}
          data-testid="projects-pending-invite"
          orientation="horizontal"
          variant="outlined"
          sx={{ alignItems: 'center', gap: 2, flexWrap: 'wrap' }}
        >
          <Box flex={1} minWidth={0}>
            <Typography level="title-sm" sx={{ overflowWrap: 'anywhere' }}>
              {invite.name || 'Untitled project'}
            </Typography>
            <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
              {invite.username || 'Someone'} invited you to join this project
            </Typography>
          </Box>
          <Box display="flex" gap={1} flexShrink={0}>
            <Button
              data-testid="projects-pending-invite-decline-btn"
              variant="outlined"
              color="danger"
              size="sm"
              disabled={busyId !== null}
              onClick={() => respond(invite, false)}
            >
              Decline
            </Button>
            <Button
              data-testid="projects-pending-invite-accept-btn"
              size="sm"
              disabled={busyId !== null}
              loading={busyId === invite.id && acceptInvite.isPending}
              onClick={() => respond(invite, true)}
            >
              Accept
            </Button>
          </Box>
        </Card>
      ))}
    </Box>
  );
};

export default PendingProjectInvites;
