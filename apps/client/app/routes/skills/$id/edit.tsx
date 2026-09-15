import { FC } from 'react';
import { Box, CircularProgress, Stack, Typography } from '@mui/joy';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useGetSkill, useUpdateSkill } from '@client/app/hooks/data/skills';
import { SkillForm } from '@client/app/components/SkillsManagement/SkillForm';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const EditSkillPage: FC = () => {
  const { id } = useParams({ strict: false }) as { id: string };
  const navigate = useNavigate();
  const { data: skill, isLoading } = useGetSkill(id);
  const updateSkill = useUpdateSkill();

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

        <SkillForm
          initialValue={{
            name: skill.name,
            description: skill.description,
            body: skill.body,
            argumentHint: skill.argumentHint,
            disableModelInvocation: skill.disableModelInvocation,
          }}
          submitLabel="Save changes"
          submitting={updateSkill.isPending}
          onCancel={() => navigate({ to: '/skills/$id', params: { id } })}
          onSubmit={async input => {
            await updateSkill.mutateAsync({ id, ...input });
            await navigate({ to: '/skills/$id', params: { id } });
          }}
        />
      </Stack>
    </Box>
  );
};

export default EditSkillPage;
