import { FC, useState, useEffect } from 'react';
import { Card, Typography, Box, Button, Stack, Textarea, FormControl, FormLabel, FormHelperText } from '@mui/joy';
import { IOrganizationDocument } from '@bike4mind/common';
import { useDeleteOrganization, useUpdateOrganization } from '@client/app/hooks/data/organizations';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import { useNavigate } from '@tanstack/react-router';

const MAX_SYSTEM_PROMPT_LENGTH = 10000; // ~2500 tokens

const OrganizationSettingsSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const deleteOrganization = useDeleteOrganization();
  const updateOrganization = useUpdateOrganization();
  const setConfirmationModal = useConfirmationModal.setState;
  const navigate = useNavigate();

  const [systemPrompt, setSystemPrompt] = useState(organization.systemPrompt || '');
  const [hasChanges, setHasChanges] = useState(false);

  // Reset form when organization changes
  useEffect(() => {
    setSystemPrompt(organization.systemPrompt || '');
    setHasChanges(false);
  }, [organization.systemPrompt]);

  const handleSystemPromptChange = (value: string) => {
    setSystemPrompt(value);
    setHasChanges(value !== (organization.systemPrompt || ''));
  };

  const handleSaveSystemPrompt = async () => {
    await updateOrganization.mutateAsync({
      orgId: organization.id,
      data: { systemPrompt },
    });
    setHasChanges(false);
  };

  const handleDelete = () => {
    setConfirmationModal({
      open: true,
      type: 'danger',
      title: 'Delete Organization',
      description: 'Are you sure you want to delete this organization? This action cannot be undone.',
      okLabel: 'Delete',
      onOk: async () => {
        await deleteOrganization.mutateAsync(organization.id);
        navigate({ to: '/organizations' });
      },
    });
  };

  return (
    <Stack spacing={3} className="organization-settings-container">
      {/* Team System Prompt */}
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          Team System Prompt
        </Typography>
        <Stack spacing={2} sx={{ p: 2 }}>
          <FormControl>
            <FormLabel>Organization-wide AI Context</FormLabel>
            <Textarea
              value={systemPrompt}
              onChange={e => handleSystemPromptChange(e.target.value)}
              placeholder="Enter custom context that will be included in all AI conversations for team members. For example: 'Our company specializes in lunar space elevators, not Earth-based ones. Always focus on lunar applications when discussing space elevator technology.'"
              minRows={4}
              maxRows={12}
              slotProps={{
                textarea: {
                  maxLength: MAX_SYSTEM_PROMPT_LENGTH,
                },
              }}
              sx={{
                minHeight: '120px',
              }}
            />
            <FormHelperText>
              {systemPrompt.length.toLocaleString()} / {MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()} characters (~
              {Math.round(systemPrompt.length / 4).toLocaleString()} tokens)
            </FormHelperText>
          </FormControl>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            This prompt is automatically injected into every AI conversation for all team members. Use it to provide
            domain-specific context, correct model biases, or establish organizational guidelines.
          </Typography>
          <Box>
            <Button
              color="primary"
              onClick={handleSaveSystemPrompt}
              loading={updateOrganization.isPending}
              disabled={!hasChanges}
            >
              Save System Prompt
            </Button>
          </Box>
        </Stack>
      </Card>

      {/* Danger Zone */}
      <Card variant="outlined">
        <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          Danger Zone
        </Typography>
        <Box sx={{ p: 2 }} className="organization-settings-card-content">
          <Button
            color="danger"
            variant="outlined"
            onClick={handleDelete}
            loading={deleteOrganization.isPending}
            className="organization-settings-delete-button"
          >
            Delete Organization
          </Button>
        </Box>
      </Card>
    </Stack>
  );
};

export default OrganizationSettingsSection;
