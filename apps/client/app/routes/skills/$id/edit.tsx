import { FC } from 'react';
import { Alert, Box, CircularProgress, Stack, Typography } from '@mui/joy';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useUser } from '@client/app/contexts/UserContext';
import { useGetSkill, useUpdateSkill } from '@client/app/hooks/data/skills';
import { SkillForm } from '@client/app/components/SkillsManagement/SkillForm';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { getErrorMessage } from '@client/app/utils/error';

const EditSkillPage: FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data: skill, isLoading } = useGetSkill(id);
  const updateSkill = useUpdateSkill();
  const isAdmin = Boolean(useUser().currentUser?.isAdmin);

  useDocumentTitle(skill ? `Edit /${skill.name}` : 'Edit skill');

  if (isLoading) {
    return (
      <Stack alignItems="center" sx={{ py: 8 }}>
        <CircularProgress />
      </Stack>
    );
  }

  if (!skill) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography>Skill not found.</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 3,
        overflowY: 'auto',
        ...scrollbarStyles,
      }}
      data-testid="edit-skill-page"
    >
      <Stack spacing={3} sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
        <Typography level="h2">
          Edit <Typography component="code">/{skill.name}</Typography>
        </Typography>

        {!isAdmin && (skill.isGlobalRead || skill.isGlobalWrite) && (
          <Alert color="neutral" variant="soft" data-testid="skill-edit-global-alert">
            This skill is shared with everyone, so content changes are reviewed by the Skill Market safety scan when you
            save.
          </Alert>
        )}

        {updateSkill.error && (
          <Alert color="danger" variant="soft" data-testid="skill-edit-error-alert">
            {getErrorMessage(updateSkill.error)}
          </Alert>
        )}

        <SkillForm
          initialValue={{
            name: skill.name,
            description: skill.description,
            body: skill.body,
            argumentHint: skill.argumentHint,
            claudeCodeAllowedTools: skill.claudeCodeAllowedTools,
            disableModelInvocation: skill.disableModelInvocation,
            files: skill.files,
          }}
          submitLabel="Save changes"
          submitting={updateSkill.isPending}
          onCancel={() => navigate({ to: '/skills/$id', params: { id } })}
          onSubmit={async input => {
            // A failed save is shown by the alert above from `updateSkill.error`; SkillForm doesn't await this.
            try {
              await updateSkill.mutateAsync({ id, ...input });
            } catch {
              return;
            }
            await navigate({ to: '/skills/$id', params: { id } });
          }}
        />
      </Stack>
    </Box>
  );
};

export default EditSkillPage;
