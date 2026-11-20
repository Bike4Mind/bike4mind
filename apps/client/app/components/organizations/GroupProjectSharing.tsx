import { useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/joy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchProjects } from '@client/app/hooks/data/projects';
import { useUser } from '@client/app/contexts/UserContext';
import { shareGroupProject } from '@client/app/utils/groupsAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { toast } from 'sonner';

export function GroupProjectSharing({ organizationId, groupId }: { organizationId: string; groupId: string }) {
  const [expanded, setExpanded] = useState(false);
  return expanded ? (
    <ProjectPicker organizationId={organizationId} groupId={groupId} />
  ) : (
    <Button variant="plain" data-testid={`org-group-projects-${groupId}`} onClick={() => setExpanded(true)}>
      Share a project
    </Button>
  );
}

function ProjectPicker({ organizationId, groupId }: { organizationId: string; groupId: string }) {
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const projects = useSearchProjects(
    '',
    {},
    { by: 'updatedAt', direction: 'desc' },
    { enabled: !!currentUser, propagateErrors: true }
  );
  const mutation = useMutation({
    mutationFn: ({ projectId, enabled }: { projectId: string; enabled: boolean }) =>
      shareGroupProject(organizationId, groupId, projectId, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project sharing updated');
    },
    onError: error => toast.error(getErrorMessage(error)),
  });
  const owned =
    projects.data?.pages.flatMap(page => page.data).filter(project => project.userId === currentUser?.id) ?? [];
  return (
    <Stack spacing={1}>
      <Typography level="body-sm">Share your projects with this group (read access).</Typography>
      {projects.isPending && <Typography level="body-sm">Loading projects...</Typography>}
      {projects.isError && (
        <Alert color="warning" data-testid="org-group-projects-error">
          <Stack spacing={0.5}>
            <Typography level="body-sm">
              {projects.data ? 'Could not refresh projects. Showing the last loaded list.' : 'Could not load projects.'}
            </Typography>
            <Button
              size="sm"
              variant="plain"
              loading={projects.isFetching}
              onClick={() => void projects.refetch()}
              data-testid="org-group-projects-retry"
            >
              Retry
            </Button>
          </Stack>
        </Alert>
      )}
      {owned.map(project => {
        const shared = project.groups?.some(group => group.groupId === groupId) ?? false;
        return (
          <Stack key={project.id} direction="row" spacing={1} alignItems="center">
            <Typography level="body-sm">{project.name}</Typography>
            <Button
              size="sm"
              variant="soft"
              loading={mutation.isPending}
              data-testid={`org-group-share-${project.id}`}
              onClick={() => mutation.mutate({ projectId: project.id, enabled: !shared })}
            >
              {shared ? 'Stop sharing' : 'Share'}
            </Button>
          </Stack>
        );
      })}
      {!projects.isPending && !projects.isError && owned.length === 0 && (
        <Typography level="body-sm">No owned projects on this page.</Typography>
      )}
      {projects.hasNextPage && (
        <Button
          variant="plain"
          loading={projects.isFetchingNextPage}
          data-testid="org-group-projects-more"
          onClick={() => projects.fetchNextPage()}
        >
          Load more projects
        </Button>
      )}
    </Stack>
  );
}
