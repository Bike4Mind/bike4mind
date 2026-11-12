import { FC, useState, useEffect, useMemo } from 'react';
import { Card, Typography, Box, Button, Stack, Textarea, FormControl, FormLabel, FormHelperText } from '@mui/joy';
import { IOrganizationDocument, orgAclRowConfersMembership } from '@bike4mind/common';
import {
  useDeleteOrganization,
  useTransferOrganizationOwnership,
  useUpdateOrganization,
} from '@client/app/hooks/data/organizations';
import { useGetOrganizationUsers } from '@client/app/hooks/data/user';
import { useConfirmationModal } from '@client/app/hooks/useConfirmation';
import { useUser } from '@client/app/contexts/UserContext';
import { useNavigate } from '@tanstack/react-router';
import TransferOwnershipModal, { TransferCandidate } from './TransferOwnershipModal';
import OrganizationMfaPolicy from './OrganizationMfaPolicy';
import { OrganizationSharingSettings } from './OrganizationSharingSettings';

const MAX_SYSTEM_PROMPT_LENGTH = 10000; // ~2500 tokens

const OrganizationSettingsSection: FC<{ organization: IOrganizationDocument }> = ({ organization }) => {
  const deleteOrganization = useDeleteOrganization();
  const updateOrganization = useUpdateOrganization();
  const setConfirmationModal = useConfirmationModal.setState;
  const navigate = useNavigate();
  const { currentUser } = useUser();

  // Mirrors the server gate in organizationService/delete.ts: billing owner or platform admin only.
  // The rest of this tab is open to anyone with org update/share, so the Danger Zone needs its own
  // narrower predicate - otherwise a member with update sees a Delete button whose call would 403.
  const canDeleteOrg = useMemo(() => {
    if (!currentUser) return false;
    return currentUser.isAdmin === true || currentUser.id === organization.userId;
  }, [currentUser, organization.userId]);

  // The owner tier of organizationService.transferOwnership (a platform admin reaches it only if the
  // Settings tab is open to them); a personal org has no successor.
  const canTransferOwnership = canDeleteOrg && !organization.personal;
  const [transferOpen, setTransferOpen] = useState(false);
  const transferOwnership = useTransferOrganizationOwnership();
  const { data: members, isSuccess: membersLoaded } = useGetOrganizationUsers(
    canTransferOwnership ? organization.id : null
  );
  const transferCandidates = useMemo<TransferCandidate[]>(() => {
    const managerIds = new Set((organization.adminUserIds ?? []).map(String));
    // The same eligibility transferOwnership enforces, so the list never offers a target it refuses.
    const memberRows = new Map((organization.users ?? []).map(row => [String(row.userId), row]));
    return (members ?? [])
      .filter(member => {
        const row = memberRows.get(member.id);
        return (
          member.id !== organization.userId &&
          managerIds.has(member.id) &&
          !member.isBanned &&
          !!row &&
          orgAclRowConfersMembership(row)
        );
      })
      .map(member => ({ id: member.id, name: member.name, email: member.email }));
  }, [members, organization.adminUserIds, organization.userId, organization.users]);

  const handleTransfer = async (newOwnerId: string) => {
    await transferOwnership.mutateAsync({ organizationId: organization.id, newOwnerId });
    // Settings is not an owner-only tab, but Billing and this zone are; land where the former owner can now leave.
    navigate({ to: '/organizations/$id', params: { id: organization.id }, search: { tab: 'members' }, replace: true });
  };

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
      <OrganizationMfaPolicy organization={organization} />
      <OrganizationSharingSettings organization={organization} />
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
                  'data-testid': 'organization-settings-system-prompt-input',
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
              data-testid="organization-settings-system-prompt-save-btn"
            >
              Save System Prompt
            </Button>
          </Box>
        </Stack>
      </Card>

      {/* Danger Zone */}
      {canDeleteOrg && (
        <Card variant="outlined">
          <Typography level="title-sm" sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
            Danger Zone
          </Typography>
          <Stack spacing={2} sx={{ p: 2 }} className="organization-settings-card-content">
            {canTransferOwnership && (
              <Stack spacing={1} alignItems="flex-start">
                <Typography level="body-sm">
                  Hand this team, including its billing, to one of its managers. You stay on as a member and can then
                  leave.
                </Typography>
                <Button
                  color="danger"
                  variant="outlined"
                  onClick={() => setTransferOpen(true)}
                  disabled={transferCandidates.length === 0}
                  data-testid="organization-settings-transfer-btn"
                >
                  Transfer Ownership
                </Button>
                {membersLoaded && transferCandidates.length === 0 && (
                  <Typography
                    level="body-xs"
                    sx={{ color: 'text.tertiary' }}
                    data-testid="organization-settings-transfer-hint"
                  >
                    Make someone a manager from the Members tab first.
                  </Typography>
                )}
              </Stack>
            )}
            <Box>
              <Button
                color="danger"
                variant="outlined"
                onClick={handleDelete}
                loading={deleteOrganization.isPending}
                className="organization-settings-delete-button"
                data-testid="organization-settings-delete-btn"
              >
                Delete Organization
              </Button>
            </Box>
          </Stack>
        </Card>
      )}
      {canTransferOwnership && (
        <TransferOwnershipModal
          open={transferOpen}
          organizationName={organization.name}
          candidates={transferCandidates}
          transferring={transferOwnership.isPending}
          onClose={() => setTransferOpen(false)}
          onTransfer={handleTransfer}
        />
      )}
    </Stack>
  );
};

export default OrganizationSettingsSection;
