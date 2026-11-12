import { ORG_INVITE_ROLES, OrgInviteRole } from '@bike4mind/common';
import {
  useCreateOrganizationInviteLink,
  useOrganizationInviteLinks,
  useRevokeOrganizationInviteLink,
  type OrgInviteLink,
} from '@client/app/hooks/data/organizations';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import LinkIcon from '@mui/icons-material/Link';
import { Box, Button, Card, Chip, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { FC, useState } from 'react';
import { toast } from 'sonner';
import OrgInviteRoleSelect from './OrgInviteRoleSelect';

// Must stay in sync with sharingService.MAX_ORG_LINK_AVAILABLE (b4m-core/services/src/sharingService/create.ts).
const MAX_ORG_LINK_AVAILABLE = 1000;
const EXPIRY_PRESET_DAYS = [1, 7, 30] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDomains(input: string): string[] {
  return [
    ...new Set(
      input
        .split(/[\s,;]+/)
        .map(domain => domain.trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean)
    ),
  ];
}

const linkStatus = (link: OrgInviteLink): string => {
  if (link.revokedAt) return 'Revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (link.remaining <= 0) return 'Used up';
  return 'Active';
};

interface InviteLinksPanelProps {
  organizationId: string;
  /** isOrgOwnerOrPlatformAdmin: only the owner tier may mint a link above Viewer. */
  isOwnerTier: boolean;
}

const InviteLinksPanel: FC<InviteLinksPanelProps> = ({ organizationId, isOwnerTier }) => {
  const [role, setRole] = useState<OrgInviteRole>('viewer');
  const [days, setDays] = useState<number>(7);
  const [cap, setCap] = useState('');
  const [domains, setDomains] = useState('');
  const { data: links = [] } = useOrganizationInviteLinks(organizationId);
  const createLink = useCreateOrganizationInviteLink(organizationId);
  const revokeLink = useRevokeOrganizationInviteLink(organizationId);
  const confirm = useConfirmation();

  const capValue = cap.trim() === '' ? undefined : Number(cap);
  const capInvalid =
    capValue !== undefined && (!Number.isInteger(capValue) || capValue < 1 || capValue > MAX_ORG_LINK_AVAILABLE);

  const handleCreate = () => {
    const allowedDomains = parseDomains(domains);
    createLink.mutate(
      {
        permissions: [...ORG_INVITE_ROLES[role]],
        expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
        ...(capValue !== undefined && { available: capValue }),
        ...(allowedDomains.length > 0 && { allowedDomains }),
      },
      { onSuccess: () => setCap('') }
    );
  };

  const handleCopy = async (link: OrgInviteLink) => {
    if (!link.link) return;
    try {
      await navigator.clipboard.writeText(link.link);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const handleRevoke = (link: OrgInviteLink) => {
    confirm({
      title: 'Revoke invite link',
      description: 'Anyone holding this link will no longer be able to join.',
      type: 'danger',
      okLabel: 'Revoke',
      onOk: () => revokeLink.mutate(link.id),
    });
  };

  return (
    <Card variant="outlined" data-testid="org-invite-links-panel">
      <Typography level="title-sm" startDecorator={<LinkIcon />}>
        Invite links
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="flex-end">
        <OrgInviteRoleSelect
          value={role}
          onChange={setRole}
          canGrantAdmin={isOwnerTier}
          viewerOnly={!isOwnerTier}
          testId="org-invite-link-role-select"
        />
        <FormControl size="sm">
          <FormLabel>Expires in</FormLabel>
          <Select
            data-testid="org-invite-link-expiry-select"
            value={days}
            onChange={(_event, next) => next && setDays(next)}
          >
            {EXPIRY_PRESET_DAYS.map(preset => (
              <Option key={preset} value={preset}>
                {preset === 1 ? '1 day' : `${preset} days`}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl size="sm" error={capInvalid}>
          <FormLabel>Max joins</FormLabel>
          <Input
            type="number"
            slotProps={{ input: { 'data-testid': 'org-invite-link-cap-input', min: 1, max: MAX_ORG_LINK_AVAILABLE } }}
            placeholder="Seats left"
            value={cap}
            onChange={event => setCap(event.target.value)}
            sx={{ width: 120 }}
          />
        </FormControl>
        <FormControl size="sm" sx={{ flex: 1, minWidth: 180 }}>
          <FormLabel>Allowed email domains</FormLabel>
          <Input
            slotProps={{ input: { 'data-testid': 'org-invite-link-domains-input' } }}
            placeholder="Any (e.g. example.com)"
            value={domains}
            onChange={event => setDomains(event.target.value)}
          />
        </FormControl>
        <Button
          data-testid="org-invite-link-create-btn"
          size="sm"
          disabled={capInvalid}
          loading={createLink.isPending}
          onClick={handleCreate}
        >
          Create link
        </Button>
      </Stack>
      {links.length > 0 && (
        <Stack spacing={1} data-testid="org-invite-links-list">
          {links.map(link => {
            const status = linkStatus(link);
            return (
              <Box
                key={link.id}
                data-testid={`org-invite-link-row-${link.id}`}
                sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
              >
                <Chip size="sm" variant="soft" color={status === 'Active' ? 'success' : 'neutral'}>
                  {status}
                </Chip>
                <Typography level="body-sm" sx={{ flex: 1, minWidth: 0 }} noWrap>
                  {link.accepted} joined, {Math.max(link.remaining, 0)} left
                  {link.expiresAt && ` - expires ${new Date(link.expiresAt).toLocaleDateString()}`}
                  {link.allowedDomains.length > 0 && ` - ${link.allowedDomains.join(', ')} only`}
                </Typography>
                {status === 'Active' && (
                  <>
                    {link.link && (
                      <Button
                        data-testid={`org-invite-link-copy-${link.id}`}
                        size="sm"
                        variant="plain"
                        onClick={() => handleCopy(link)}
                      >
                        Copy
                      </Button>
                    )}
                    <Button
                      data-testid={`org-invite-link-revoke-${link.id}`}
                      size="sm"
                      variant="plain"
                      color="danger"
                      disabled={revokeLink.isPending}
                      onClick={() => handleRevoke(link)}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </Box>
            );
          })}
        </Stack>
      )}
    </Card>
  );
};

export default InviteLinksPanel;
