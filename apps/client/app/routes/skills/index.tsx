import { FC, useMemo, useState } from 'react';
import { Box, Button, Card, CircularProgress, IconButton, Input, Stack, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { useNavigate } from '@tanstack/react-router';
import { ISkill } from '@bike4mind/common';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useDeleteSkill, useGetSkills } from '@client/app/hooks/data/skills';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';

const SkillsListPage: FC = () => {
  useDocumentTitle('Skills');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const { data: skills = [], isLoading } = useGetSkills();
  const deleteSkill = useDeleteSkill();

  const visibleSkills = useMemo(() => {
    if (!search.trim()) return skills;
    const term = search.toLowerCase();
    return skills.filter(s => s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term));
  }, [skills, search]);

  const handleDelete = async (skill: ISkill) => {
    if (!window.confirm(`Delete skill "${skill.name}"? This cannot be undone.`)) return;
    await deleteSkill.mutateAsync(skill.id);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        p: 3,
        gap: 2,
        overflowY: 'auto',
        ...scrollbarStyles,
      }}
      data-testid="skills-list-page"
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Box>
          <Typography level="h2">Skills</Typography>
          <Typography level="body-sm" textColor="text.tertiary">
            Reusable instruction templates you can invoke with <code>/name</code> in chat.
          </Typography>
        </Box>
        <Button
          startDecorator={<AddIcon />}
          onClick={() => navigate({ to: '/skills/new' })}
          data-testid="skills-create-button"
        >
          New skill
        </Button>
      </Stack>

      <Input
        startDecorator={<SearchIcon />}
        placeholder="Search by name or description"
        value={search}
        onChange={e => setSearch(e.target.value)}
        slotProps={{ input: { 'data-testid': 'skills-search-input' } }}
      />

      {isLoading ? (
        <Stack alignItems="center" sx={{ py: 8 }}>
          <CircularProgress />
        </Stack>
      ) : visibleSkills.length === 0 ? (
        <Card variant="soft" sx={{ p: 4, textAlign: 'center' }} data-testid="skills-empty-state">
          <Typography level="title-md">
            {skills.length === 0 ? 'No skills yet' : 'No skills match your search'}
          </Typography>
          <Typography level="body-sm" textColor="text.tertiary" sx={{ mt: 1 }}>
            {skills.length === 0
              ? 'Create your first skill to start invoking it with /name in chat.'
              : 'Try a different search term.'}
          </Typography>
        </Card>
      ) : (
        <Stack spacing={1.5}>
          {visibleSkills.map(skill => (
            <Card
              key={skill.id}
              variant="outlined"
              sx={{ p: 2, '&:hover': { borderColor: 'primary.outlinedBorder' } }}
              data-testid={`skill-card-${skill.name}`}
            >
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
                <Box
                  sx={{ flex: 1, cursor: 'pointer' }}
                  onClick={() => navigate({ to: '/skills/$id', params: { id: skill.id } })}
                >
                  <Typography level="title-sm" component="code">
                    /{skill.name}
                    {skill.argumentHint ? <span style={{ opacity: 0.6 }}> {skill.argumentHint}</span> : null}
                  </Typography>
                  <Typography level="body-sm" textColor="text.tertiary">
                    {skill.description}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={0.5}>
                  <IconButton
                    size="sm"
                    variant="plain"
                    onClick={() => navigate({ to: '/skills/$id/edit', params: { id: skill.id } })}
                    data-testid={`skill-edit-${skill.name}`}
                    aria-label={`Edit ${skill.name}`}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={() => handleDelete(skill)}
                    data-testid={`skill-delete-${skill.name}`}
                    aria-label={`Delete ${skill.name}`}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              </Stack>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default SkillsListPage;
