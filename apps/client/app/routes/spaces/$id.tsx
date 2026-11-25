import React, { useEffect, useState } from 'react';
import { Box, Button, CircularProgress, Input, Stack, Tabs, TabList, TabPanel, Textarea, Typography } from '@mui/joy';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX } from '@bike4mind/common';
import NotFound from '@client/app/components/NotFound';
import Breadcrumbs from '@client/app/components/common/Breadcrumbs';
import PageFrame from '@client/app/components/common/PageFrame';
import { PageTab, pageTabListSx } from '@client/app/components/common/pageTabs';
import OrgDomainsTab from '@client/app/components/organizations/OrgDomainsTab';
import SpaceInvitesTab from '@client/app/components/spaces/SpaceInvitesTab';
import SpaceLinksTab from '@client/app/components/spaces/SpaceLinksTab';
import SpaceMembersTab from '@client/app/components/spaces/SpaceMembersTab';
import { useUser } from '@client/app/contexts/UserContext';
import {
  useDeleteSpace,
  useLeaveSpace,
  useSpace,
  useUpdateSpace,
  type SpaceDetail,
} from '@client/app/hooks/data/spaces';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useSpacesEnabled } from '@client/app/hooks/useSpacesEnabled';
import { resolveSpaceTab, SpaceTabs, visibleSpaceTabs } from './spaceTabAccess';

const TAB_LABELS: Record<SpaceTabs, string> = {
  [SpaceTabs.Members]: 'Members',
  [SpaceTabs.Invites]: 'Invites',
  [SpaceTabs.Links]: 'Links',
  [SpaceTabs.Domains]: 'Domains',
  [SpaceTabs.Settings]: 'Settings',
};

const Loader = () => (
  <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
    <CircularProgress />
  </Box>
);

const SpaceSettingsTab: React.FC<{ space: SpaceDetail }> = ({ space }) => {
  const navigate = useNavigate();
  const confirm = useConfirmation();
  const update = useUpdateSpace(space.id);
  const remove = useDeleteSpace(space.id);
  const [name, setName] = useState(space.name);
  const [description, setDescription] = useState(space.description ?? '');
  const isOwner = space.viewerRole === 'owner';
  const dirty = name.trim() !== space.name || description.trim() !== (space.description ?? '');

  useEffect(() => {
    setName(space.name);
    setDescription(space.description ?? '');
  }, [space.name, space.description]);

  const handleDelete = () =>
    confirm({
      title: 'Delete space',
      description: 'This removes the space for every member. It cannot be undone.',
      type: 'danger',
      okLabel: 'Delete',
      onOk: async () => {
        await remove.mutateAsync();
        void navigate({ to: '/spaces' });
      },
    });

  return (
    <Stack spacing={2} data-testid="space-settings-tab" sx={{ maxWidth: 520 }}>
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        slotProps={{ input: { maxLength: SPACE_NAME_MAX, 'data-testid': 'space-settings-name-input' } }}
      />
      <Textarea
        minRows={2}
        value={description}
        onChange={e => setDescription(e.target.value)}
        slotProps={{
          textarea: { maxLength: SPACE_DESCRIPTION_MAX, 'data-testid': 'space-settings-description-input' },
        }}
      />
      <Box>
        <Button
          disabled={!dirty || !name.trim()}
          loading={update.isPending}
          onClick={() => update.mutate({ name: name.trim(), description: description.trim() || null })}
          data-testid="space-settings-save-btn"
        >
          Save
        </Button>
      </Box>
      {isOwner && (
        <Box>
          <Button color="danger" variant="outlined" onClick={handleDelete} data-testid="space-delete-btn">
            Delete space
          </Button>
        </Box>
      )}
    </Stack>
  );
};

const SpaceDetailPage: React.FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const { currentUser } = useUser();
  const confirm = useConfirmation();
  const { enabled, ready } = useSpacesEnabled();
  const { data: space, isPending, isError } = useSpace(id, enabled);
  const leave = useLeaveSpace(id);
  useDocumentTitle(space?.name, 'Space');

  if (!ready) return <Loader />;
  if (!enabled) return <NotFound />;
  if (isPending) return <Loader />;
  if (isError || !space) {
    return (
      <Stack spacing={2} alignItems="center" sx={{ p: 4 }} role="alert" data-testid="space-error-state">
        <Typography level="h2">Space not found</Typography>
        <Typography>This space may have been removed, or you are not a member.</Typography>
        <Button onClick={() => void navigate({ to: '/spaces' })} data-testid="space-back-btn">
          All spaces
        </Button>
      </Stack>
    );
  }

  const tabs = visibleSpaceTabs(space.viewerRole);
  const selected = resolveSpaceTab(search.tab, space.viewerRole);
  const canLeave = space.viewerRole !== 'owner';

  const handleLeave = () =>
    confirm({
      title: 'Leave space',
      description: `You will lose access to ${space.name}.`,
      type: 'danger',
      okLabel: 'Leave',
      onOk: async () => {
        await leave.mutateAsync();
        void navigate({ to: '/spaces' });
      },
    });

  return (
    <PageFrame testId="space-detail-page">
      <Stack spacing={2}>
        <Breadcrumbs items={[{ name: 'Spaces', href: '/spaces' }, { name: space.name }]} />
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography level="h2">{space.name}</Typography>
            {space.description && <Typography level="body-sm">{space.description}</Typography>}
          </Box>
          {canLeave && (
            <Button variant="outlined" color="danger" onClick={handleLeave} data-testid="space-leave-btn">
              Leave space
            </Button>
          )}
        </Box>
        <Tabs
          value={selected}
          onChange={(_e, value) =>
            void navigate({ to: '/spaces/$id', params: { id }, search: { tab: value as string } })
          }
        >
          <TabList sx={pageTabListSx}>
            {tabs.map(tab => (
              <PageTab key={tab} value={tab} data-testid={`space-tab-${tab}`}>
                {TAB_LABELS[tab]}
              </PageTab>
            ))}
          </TabList>
          <TabPanel value={SpaceTabs.Members}>
            <SpaceMembersTab space={space} currentUserId={currentUser?.id} />
          </TabPanel>
          {tabs.includes(SpaceTabs.Invites) && (
            <TabPanel value={SpaceTabs.Invites}>
              <SpaceInvitesTab spaceId={space.id} />
            </TabPanel>
          )}
          {tabs.includes(SpaceTabs.Links) && (
            <TabPanel value={SpaceTabs.Links}>
              <SpaceLinksTab spaceId={space.id} />
            </TabPanel>
          )}
          {tabs.includes(SpaceTabs.Domains) && (
            <TabPanel value={SpaceTabs.Domains}>
              <OrgDomainsTab owner={{ kind: 'space', id: space.id }} />
            </TabPanel>
          )}
          {tabs.includes(SpaceTabs.Settings) && (
            <TabPanel value={SpaceTabs.Settings}>
              <SpaceSettingsTab space={space} />
            </TabPanel>
          )}
        </Tabs>
      </Stack>
    </PageFrame>
  );
};

export default SpaceDetailPage;
