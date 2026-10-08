import { useAcceptDocument, useRefuseDocument } from '@client/app/hooks/data/invites';
import { fetchInvite } from '@client/app/utils/invitesAPICalls';
import CheckIcon from '@mui/icons-material/Check';
import ConstructionOutlinedIcon from '@mui/icons-material/ConstructionOutlined';
import DoDisturbIcon from '@mui/icons-material/DoDisturb';
import GroupIcon from '@mui/icons-material/Group';
import HomeIcon from '@mui/icons-material/Home';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import NoteAltOutlinedIcon from '@mui/icons-material/NoteAltOutlined';
import PsychologyIcon from '@mui/icons-material/Psychology';
import HubIconIcon from '@mui/icons-material/Hub';
import {
  Avatar,
  Box,
  Button,
  Divider,
  IconButton,
  LinearProgress,
  ListItem,
  ListItemContent,
  ListItemDecorator,
  Modal,
  ModalClose,
  Sheet,
  Tooltip,
  Typography,
} from '@mui/joy';
import { useNavigate, useParams } from '@tanstack/react-router';
import React from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useQuery } from '@tanstack/react-query';

const DOCUMENT_ICONS = {
  FabFile: <PsychologyIcon />,
  Group: <GroupIcon />,
  Organization: <HomeIcon />,
  Session: <NoteAltOutlinedIcon />,
  Tool: <ConstructionOutlinedIcon />,
  Project: <HubIconIcon />,
};

const StatusModal = ({
  testId,
  title,
  body,
  actionTestId,
  actionLabel,
  onAction,
  onClose,
}: {
  testId: string;
  title: string;
  body: string;
  actionTestId: string;
  actionLabel: string;
  onAction: () => void;
  onClose: () => void;
}) => (
  <Modal open sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClose={onClose}>
    <Sheet data-testid={testId} sx={{ minHeight: '200px', width: '420px', padding: '20px' }}>
      <ModalClose variant="plain" sx={{ m: 1 }} />
      <Box display={'flex'} flexDirection={'column'} gap={2}>
        <Typography level={'h3'}>{title}</Typography>
        <Typography level={'body-md'}>{body}</Typography>
        <Button data-testid={actionTestId} onClick={onAction}>
          {actionLabel}
        </Button>
      </Box>
    </Sheet>
  </Modal>
);

const SharePage = () => {
  const [loading, setLoading] = React.useState<boolean>(false);
  const navigate = useNavigate();
  const { id } = useParams({ strict: false });
  const { currentUser } = useUser();
  const goHome = () => navigate({ to: '/' });

  // Parse multiple IDs from URL (comma-separated)
  const inviteIds = React.useMemo(() => {
    if (!id) return [];
    const ids = (id as string)
      .split(',')
      .map(i => i.trim())
      .filter(Boolean);
    return ids;
  }, [id]);

  // Fetch multiple invites
  const query = useQuery({
    queryKey: ['invites', 'multiple', inviteIds.sort()],
    queryFn: async () => {
      const results = await Promise.allSettled(inviteIds.map(inviteId => fetchInvite(inviteId)));
      const isPastExpiry = (inv: { expiresAt?: Date | string | null }) =>
        !!inv.expiresAt && new Date(inv.expiresAt).getTime() <= Date.now();
      const items = results.flatMap((r, i) =>
        r.status === 'fulfilled' && r.value && r.value !== 'expired' && !isPastExpiry(r.value)
          ? [{ id: inviteIds[i], invite: r.value }]
          : []
      );
      const expired = results.some(
        r => r.status === 'fulfilled' && r.value && (r.value === 'expired' || isPastExpiry(r.value))
      );
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (!items.length && !expired && failed) {
        console.error('Failed to load invite', failed.reason);
        throw failed.reason;
      }
      return { items, expired };
    },
    enabled: inviteIds.length > 0,
  });

  const invites = query.data?.items ?? [];
  const isMultiple = invites.length > 1;

  // Check if any invite is user's own
  const hasOwnInvite = invites.some(item => item.invite?.username === currentUser?.username);

  const acceptInvite = useAcceptDocument({
    onSuccess: () => {
      navigate({ to: '/' });
    },
    onSettled: () => setLoading(false),
    isPublic: true,
  });

  const refuseInvite = useRefuseDocument({
    onSuccess: () => {
      navigate({ to: '/' });
    },
    onSettled: () => setLoading(false),
    isPublic: true,
  });

  const handleBulkAction = async (action: 'accept' | 'refuse') => {
    setLoading(true);

    const validInvites = invites.filter(item =>
      action === 'accept' ? item.invite?.username !== currentUser?.username : true
    );

    try {
      await Promise.allSettled(
        validInvites.map(item =>
          action === 'accept' ? acceptInvite.mutateAsync(item.id) : refuseInvite.mutateAsync(item.id)
        )
      );
      goHome();
    } finally {
      setLoading(false);
    }
  };

  if (query.isLoading) return null;
  if (query.isError) {
    return (
      <StatusModal
        testId="share-error-modal"
        title="Couldn't load this invite"
        body="Something went wrong. Please try again."
        actionTestId="share-error-retry-btn"
        actionLabel="Retry"
        onAction={() => query.refetch()}
        onClose={goHome}
      />
    );
  }
  if (invites.length === 0) {
    const expired = query.data?.expired;
    const kind = expired ? 'expired' : 'unavailable';
    return (
      <StatusModal
        testId={`share-${kind}-modal`}
        title={expired ? 'This invite has expired' : 'This invite is no longer available'}
        body={
          expired
            ? 'Ask the person who shared it to send you a new one.'
            : 'It may have expired, been revoked, or already been used.'
        }
        actionTestId={`share-${kind}-home-btn`}
        actionLabel="Go home"
        onAction={goHome}
        onClose={goHome}
      />
    );
  }
  return (
    <Modal open sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} onClose={goHome}>
      <Sheet sx={{ minHeight: '200px', width: '420px', padding: '20px' }}>
        <ModalClose variant="plain" sx={{ m: 1 }} />
        {query.isFetching ? (
          <LinearProgress />
        ) : (
          <Box display={'flex'} flexDirection={'column'}>
            <Typography level={'h3'}>
              {isMultiple ? `${invites.length} Document Share Requests` : 'Document Share Request'}
            </Typography>
            <Divider sx={{ my: '20px' }} />

            <ListItem
              onClick={() => null}
              sx={{
                my: '5px',
                border: '1px solid transparent',
                borderRadius: '5px',
              }}
            >
              <ListItemDecorator>
                <Avatar color={'primary'}>{DOCUMENT_ICONS[invites[0]?.invite?.type || 'FabFile']}</Avatar>
              </ListItemDecorator>
              &nbsp;
              <ListItemContent>
                <Box display={'flex'} flexDirection={'row'} alignItems={'center'}>
                  <Box display={'flex'} flexDirection={'column'}>
                    {invites.map(({ id: inviteId, invite }) => {
                      if (!invite) return null;
                      return (
                        <Typography
                          key={inviteId}
                          sx={{
                            fontSize: '16px',
                            fontStyle: 'normal',
                            fontWeight: '400',
                            display: '-webkit-box',
                            WebkitLineClamp: 1,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-all',
                            ml: 2,
                            mb: 1,
                          }}
                        >
                          {invite.name}
                        </Typography>
                      );
                    })}
                  </Box>
                </Box>
              </ListItemContent>
              <ListItemDecorator>
                {invites.some(item => item.invite?.description) && (
                  <Tooltip title={invites.find(item => item.invite?.description)?.invite?.description}>
                    <InfoOutlinedIcon sx={{ width: '20px', mr: '10px' }} />
                  </Tooltip>
                )}
                <Tooltip title={'Refuse'}>
                  <IconButton
                    sx={{ mr: '15px' }}
                    variant={'outlined'}
                    disabled={loading}
                    color={'danger'}
                    onClick={() => handleBulkAction('refuse')}
                  >
                    <DoDisturbIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip title={hasOwnInvite ? "You can't accept your own invite" : 'Accept'}>
                  <IconButton
                    variant={'outlined'}
                    disabled={loading || hasOwnInvite}
                    color={'success'}
                    onClick={() => handleBulkAction('accept')}
                  >
                    <CheckIcon />
                  </IconButton>
                </Tooltip>
              </ListItemDecorator>
            </ListItem>

            <Box sx={{ mt: '10px' }}>
              <Typography level={'body-xs'}>
                {hasOwnInvite
                  ? 'Some invites are your own. You cannot accept invites you created.'
                  : `${invites[0]?.invite?.username || 'Someone'} has invited you to share ${isMultiple ? 'documents' : 'a document'}!`}
              </Typography>
            </Box>
          </Box>
        )}
      </Sheet>
    </Modal>
  );
};

export default SharePage;
