import { useInbox } from '@client/app/contexts/InboxContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useAcceptDocument, useGetUserInvites, useRefuseDocument } from '@client/app/hooks/data/invites';
import CheckIcon from '@mui/icons-material/Check';
import ConstructionOutlinedIcon from '@mui/icons-material/ConstructionOutlined';
import DoDisturbIcon from '@mui/icons-material/DoDisturb';
import GroupIcon from '@mui/icons-material/Group';
import HomeIcon from '@mui/icons-material/Home';
import NoteAltOutlinedIcon from '@mui/icons-material/NoteAltOutlined';
import PsychologyIcon from '@mui/icons-material/Psychology';
import SentimentSatisfied from '@mui/icons-material/SentimentSatisfied';
import HubIconIcon from '@mui/icons-material/Hub';
import { Avatar, Box, IconButton, LinearProgress, List, Typography, Tooltip, Divider } from '@mui/joy';
import { useQueryClient } from '@tanstack/react-query';
import React, { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useTheme } from '@mui/joy/styles';
import { IInviteDocumentWithDetails, InviteType } from '@bike4mind/common';
import { red, teal } from '@client/app/utils/themes/colors';

type GroupedInvite = {
  id: string;
  invites: IInviteDocumentWithDetails[];
  isBulk: boolean;
  type: string;
  name: string;
  description?: string;
  username?: string;
};

const DOCUMENT_ICONS = {
  FabFile: <PsychologyIcon />,
  Group: <GroupIcon />,
  Organization: <HomeIcon />,
  Session: <NoteAltOutlinedIcon />,
  Tool: <ConstructionOutlinedIcon />,
  Project: <HubIconIcon sx={{ color: teal[600] }} />,
};

const Invites: React.FC = () => {
  const { currentUser } = useUser();
  const userEmail = currentUser?.email;
  const theme = useTheme();
  const [loading, setLoading] = React.useState<boolean>(false);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const queryClient = useQueryClient();
  const sharedSearch = useInbox(useShallow(s => s.sharedSearch));
  const invitesQuery = useGetUserInvites(currentUser!.id);
  const [fakeInvites] = React.useState<any[]>([]);

  const acceptInvite = useAcceptDocument({
    onSettled: () => {
      setLoading(false);
      handleForceRefetch();
    },
    onError: () => {
      setLoading(false);
      setRemoved([]);
    },
  });

  const refuseInvite = useRefuseDocument({
    onSettled: () => {
      setLoading(false);
    },
    onError: () => {
      setLoading(false);
      setRemoved([]);
    },
  });

  const handleForceRefetch = () => {
    queryClient.refetchQueries({
      queryKey: ['sessions', 'shared', sharedSearch],
    });
    queryClient.refetchQueries({
      queryKey: ['projects', 'search'],
    });
  };

  const handleAcceptDocument = async (groupedInvite: GroupedInvite) => {
    setLoading(true);
    setRemoved(prev => [...prev, groupedInvite.id]);

    // Accept only the specific invite (no bulk behavior)
    try {
      acceptInvite.mutate(groupedInvite.invites[0].id);
    } catch (error) {
      setLoading(false);
      setRemoved(prev => prev.filter(id => id !== groupedInvite.id));
    }
  };

  const handleRefuseDocument = async (groupedInvite: GroupedInvite) => {
    setLoading(true);
    setRemoved(prev => [...prev, groupedInvite.id]);

    // Refuse only the specific invite (no bulk behavior)
    try {
      refuseInvite.mutate(groupedInvite.invites[0].id);
    } catch (error) {
      setLoading(false);
      setRemoved(prev => prev.filter(id => id !== groupedInvite.id));
    }
  };

  const allLoading = invitesQuery.isFetching || loading;

  // Build the flat list of invites
  const invites = useMemo(() => {
    // Only show invites that are relevant to the current user and have remaining uses
    const realInvites = (invitesQuery?.data ?? []).filter(
      i =>
        i.remaining > 0 &&
        i.recipients?.pending?.includes(userEmail || '') &&
        [InviteType.Project, InviteType.Session, InviteType.FabFile, InviteType.Organization].includes(
          i.type as InviteType
        )
    );

    // Show each invitation separately (no grouping)
    const groupedInvites: GroupedInvite[] = realInvites.map(invite => ({
      id: invite.id,
      invites: [invite],
      isBulk: false,
      type: invite.type,
      name: invite.name || 'Unknown',
      description:
        invite.type === InviteType.Project
          ? `${invite.username || 'Someone'} invited you to join ${invite.name}`
          : invite.type === InviteType.FabFile
            ? `${invite.username || 'Someone'} shared a file with you`
            : invite.type === InviteType.Organization
              ? `${invite.username || 'Someone'} invited you to join ${invite.name}`
              : invite.description,
      username: invite.username,
    }));

    return [...fakeInvites, ...groupedInvites];
  }, [invitesQuery.data, userEmail, fakeInvites]);

  // Separate invites by category: Projects, Notebooks (Sessions), and Shared Files (FabFile)
  const categorized = useMemo(() => {
    // Filter out removed invites before categorizing
    const visibleInvites = invites.filter(i => !removed.includes(i.id));
    const projects = visibleInvites.filter(i => i.type === InviteType.Project);
    const notebooks = visibleInvites.filter(i => i.type === InviteType.Session);
    const sharedFiles = visibleInvites.filter(i => i.type === InviteType.FabFile);
    const organizations = visibleInvites.filter(i => i.type === InviteType.Organization);
    return {
      projects,
      notebooks,
      sharedFiles,
      organizations,
      total: visibleInvites.length,
    };
  }, [invites, removed]);

  const renderInviteRow = (groupedInvite: GroupedInvite) => (
    <Box
      key={groupedInvite.id}
      sx={{
        position: 'relative',
        background: theme.palette.background.panel2,
        borderRadius: '8px',
        p: 2,
        mb: 2,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        border: '1px solid',
        borderColor: 'border.light',
      }}
    >
      <Avatar
        color={'primary'}
        sx={{ width: '32px', height: '32px', mr: 2, backgroundColor: 'inbox.backgroundColor.inviteIcon' }}
      >
        {DOCUMENT_ICONS[groupedInvite.type as keyof typeof DOCUMENT_ICONS]}
      </Avatar>
      <Box flex={1} minWidth={0}>
        <Tooltip title={groupedInvite.name} placement="top-start">
          <Typography
            sx={{
              fontWeight: 400,
              fontSize: '16px',
              mb: 0.5,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {groupedInvite.name}
          </Typography>
        </Tooltip>
        {groupedInvite.description && (
          <Tooltip title={groupedInvite.description} placement="top-start">
            <Typography
              sx={{
                fontSize: '13px',
                color: 'text.primary',
                mb: 0.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {groupedInvite.description}
            </Typography>
          </Tooltip>
        )}
      </Box>
      <Box display="flex" flexDirection="row" gap={1}>
        <IconButton
          data-testid="invite-refuse-btn"
          variant={'soft'}
          size="lg"
          disabled={allLoading || removed.includes(groupedInvite.id)}
          color={'danger'}
          onClick={() => handleRefuseDocument(groupedInvite)}
          sx={{
            borderRadius: '8px',
            width: '24px !important',
            height: '24px !important',
            minWidth: '24px !important',
            minHeight: '24px !important',
            border: '1px solid',
            borderColor: red[600],
          }}
        >
          <DoDisturbIcon sx={{ width: '10px', height: '10px', color: red[600] }} />
        </IconButton>
        <IconButton
          data-testid="invite-accept-btn"
          variant={'soft'}
          size="lg"
          disabled={allLoading || removed.includes(groupedInvite.id)}
          color={'success'}
          onClick={() => handleAcceptDocument(groupedInvite)}
          sx={{
            borderRadius: '8px',
            width: '24px !important',
            height: '24px !important',
            minWidth: '24px !important',
            minHeight: '24px !important',
            border: '1px solid',
            borderColor: teal[600],
          }}
        >
          <CheckIcon sx={{ width: '10px', height: '10px', color: teal[600] }} />
        </IconButton>
      </Box>
    </Box>
  );

  const renderSection = (title: string, items: GroupedInvite[]) => {
    if (items.length === 0) return null;
    return (
      <Box sx={{ mb: 3 }}>
        <Typography level="title-md" sx={{ mb: 1, color: 'text.tertiary' }}>
          {title}
        </Typography>
        <List sx={{ '--ListItemDecorator-size': '56px', p: 0 }}>{items.map(renderInviteRow)}</List>
        <Divider sx={{ mt: 1 }} />
      </Box>
    );
  };

  return (
    <>
      {allLoading && (
        <Box>
          <LinearProgress size={'sm'} sx={{ width: '100%' }} />
        </Box>
      )}

      {categorized.total === 0 && !allLoading && (
        <Box
          mt={'20px'}
          width={'100%'}
          display={'flex'}
          justifyContent={'center'}
          alignItems={'center'}
          flexDirection={'column'}
          height={'100%'}
          flex={1}
        >
          <SentimentSatisfied sx={{ fontSize: '130px', color: 'inbox.text.placeholder' }} />
          <Typography sx={{ fontSize: '16px', color: 'inbox.text.placeholder' }}>No Invites</Typography>
        </Box>
      )}

      {/* Sections: Organizations, Projects, Notebooks, Shared Files */}
      {renderSection('Organizations', categorized.organizations)}
      {renderSection('Projects', categorized.projects)}
      {renderSection('Notebooks', categorized.notebooks)}
      {renderSection('Shared files', categorized.sharedFiles)}
    </>
  );
};

export default Invites;
