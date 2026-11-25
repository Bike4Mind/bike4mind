import React, { useState } from 'react';
import { Alert, Box, Button, Card, CircularProgress, Input, Stack, Textarea, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX } from '@bike4mind/common';
import NotFound from '@client/app/components/NotFound';
import PageFrame from '@client/app/components/common/PageFrame';
import { useCreateSpace, useSpaces } from '@client/app/hooks/data/spaces';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useSpacesEnabled } from '@client/app/hooks/useSpacesEnabled';
import { getErrorMessage } from '@client/app/utils/error';

const Loader = () => (
  <Box display="flex" justifyContent="center" alignItems="center" height="100%" width="100%">
    <CircularProgress />
  </Box>
);

const SpacesPage: React.FC = () => {
  const { enabled, ready } = useSpacesEnabled();
  const navigate = useNavigate();
  const { data: spaces, isPending, isError, refetch } = useSpaces(enabled);
  const create = useCreateSpace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  useDocumentTitle('Spaces');

  if (!ready) return <Loader />;
  if (!enabled) return <NotFound />;

  const trimmedName = name.trim();
  const handleCreate = () => {
    if (!trimmedName) return;
    create.mutate(
      { name: trimmedName, ...(description.trim() && { description: description.trim() }) },
      {
        onSuccess: space => {
          setName('');
          setDescription('');
          void navigate({ to: '/spaces/$id', params: { id: space.id } });
        },
      }
    );
  };

  return (
    <PageFrame testId="spaces-page">
      <Stack spacing={3}>
        <Typography level="h2">Spaces</Typography>
        <Card variant="outlined" data-testid="space-create-card">
          <Typography level="title-sm">Create a space</Typography>
          <Input
            placeholder="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            slotProps={{ input: { maxLength: SPACE_NAME_MAX, 'data-testid': 'space-create-name-input' } }}
          />
          <Textarea
            placeholder="Description (optional)"
            minRows={2}
            value={description}
            onChange={e => setDescription(e.target.value)}
            slotProps={{
              textarea: { maxLength: SPACE_DESCRIPTION_MAX, 'data-testid': 'space-create-description-input' },
            }}
          />
          {create.isError && (
            <Alert color="danger" data-testid="space-create-error">
              {getErrorMessage(create.error)}
            </Alert>
          )}
          <Box>
            <Button
              disabled={!trimmedName}
              loading={create.isPending}
              onClick={handleCreate}
              data-testid="space-create-btn"
            >
              Create space
            </Button>
          </Box>
        </Card>
        {isPending && <CircularProgress />}
        {isError && (
          <Alert color="danger" data-testid="spaces-error">
            Spaces could not be loaded.
            <Button size="sm" variant="plain" onClick={() => void refetch()}>
              Retry
            </Button>
          </Alert>
        )}
        {spaces && spaces.length === 0 && (
          <Typography data-testid="spaces-empty">You are not in any spaces yet.</Typography>
        )}
        <Stack spacing={1.5} data-testid="spaces-list">
          {spaces?.map(space => (
            <Card
              key={space.id}
              variant="outlined"
              data-testid={`space-card-${space.id}`}
              sx={{ cursor: 'pointer' }}
              onClick={() => void navigate({ to: '/spaces/$id', params: { id: space.id } })}
            >
              <Typography level="title-md">{space.name}</Typography>
              {space.description && <Typography level="body-sm">{space.description}</Typography>}
              <Typography level="body-xs">
                {space.memberCount} {space.memberCount === 1 ? 'member' : 'members'}
                {space.isOwner ? ' - you own this space' : ''}
              </Typography>
            </Card>
          ))}
        </Stack>
      </Stack>
    </PageFrame>
  );
};

export default SpacesPage;
