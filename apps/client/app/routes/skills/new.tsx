import { FC } from 'react';
import { Box, Stack, Typography } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useCreateSkill } from '@client/app/hooks/data/skills';
import { SkillForm } from '@client/app/components/SkillsManagement/SkillForm';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const NewSkillPage: FC = () => {
  useDocumentTitle('New skill');
  const navigate = useNavigate();
  const createSkill = useCreateSkill();

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
      data-testid="new-skill-page"
    >
      <Stack spacing={3} sx={{ maxWidth: 800, mx: 'auto', width: '100%' }}>
        <Box>
          <Typography level="h2">New skill</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Author a reusable instruction template. Invoke it with <code>/name</code> in chat.
          </Typography>
        </Box>

        <SkillForm
          submitLabel="Create skill"
          submitting={createSkill.isPending}
          onCancel={() => navigate({ to: '/skills' })}
          onSubmit={async input => {
            const created = await createSkill.mutateAsync(input);
            await navigate({ to: '/skills/$id', params: { id: created.id } });
          }}
        />
      </Stack>
    </Box>
  );
};

export default NewSkillPage;
