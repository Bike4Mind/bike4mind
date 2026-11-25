import React, { useState } from 'react';
import { Box, Button, Chip, FormControl, FormLabel, Input, Option, Select, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import { INVITE_HOSTNAME_PATTERN, MAX_INVITE_ALLOWED_DOMAINS } from '@bike4mind/common';
import {
  useCreateSpaceInviteLink,
  useRevokeSpaceInviteLink,
  useSpaceInviteLinks,
  type SpaceInviteLink,
} from '@client/app/hooks/data/spaces';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { parseDomains } from '@client/app/components/organizations/InviteLinksPanel';

/** The server rejects a Space link that outlives this. */
export const MAX_SPACE_LINK_DAYS = 90;
export const SPACE_LINK_EXPIRY_DAYS = [1, 7, 30, MAX_SPACE_LINK_DAYS] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const linkStatus = (link: SpaceInviteLink): string => {
  if (link.revokedAt) return 'Revoked';
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now()) return 'Expired';
  if (link.remaining <= 0) return 'Used up';
  return 'Active';
};

/** Expiry for a link of `days`, held a minute under the 90-day cap so client/server clock skew cannot tip it over. */
export const linkExpiry = (days: number, now = Date.now()): string => {
  const clamped = Math.min(days, MAX_SPACE_LINK_DAYS);
  const skew = clamped === MAX_SPACE_LINK_DAYS ? 60_000 : 0;
  return new Date(now + clamped * DAY_MS - skew).toISOString();
};

const SpaceLinksTab: React.FC<{ spaceId: string }> = ({ spaceId }) => {
  const [days, setDays] = useState<number>(7);
  const [cap, setCap] = useState('');
  const [domains, setDomains] = useState('');
  const { data: links = [], isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useSpaceInviteLinks(spaceId);
  const create = useCreateSpaceInviteLink(spaceId);
  const revoke = useRevokeSpaceInviteLink(spaceId);
  const confirm = useConfirmation();

  const capValue = cap.trim() === '' ? undefined : Number(cap);
  const capInvalid = capValue !== undefined && (!Number.isInteger(capValue) || capValue < 1);
  const allowedDomains = parseDomains(domains);
  const domainsInvalid =
    allowedDomains.length > MAX_INVITE_ALLOWED_DOMAINS || allowedDomains.some(d => !INVITE_HOSTNAME_PATTERN.test(d));

  const handleCreate = () => {
    if (capInvalid || domainsInvalid) return;
    create.mutate(
      {
        expiresAt: linkExpiry(days),
        ...(capValue !== undefined && { available: capValue }),
        ...(allowedDomains.length > 0 && { allowedDomains }),
      },
      { onSuccess: () => setCap('') }
    );
  };

  const handleCopy = async (link: SpaceInviteLink) => {
    try {
      await navigator.clipboard.writeText(link.link);
      toast.success('Invite link copied');
    } catch {
      toast.error('Could not copy the link');
    }
  };

  const handleRevoke = (link: SpaceInviteLink) =>
    confirm({
      title: 'Revoke invite link',
      description: 'Anyone holding this link will no longer be able to join.',
      type: 'danger',
      okLabel: 'Revoke',
      onOk: async () => {
        await revoke.mutateAsync(link.id);
      },
    });

  return (
    <Stack spacing={2} data-testid="space-links-tab">
      <Typography level="body-sm" textColor="text.secondary">
        Anyone with a link joins as a member.
      </Typography>
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="flex-end">
        <FormControl size="sm">
          <FormLabel>Expires in</FormLabel>
          <Select
            value={days}
            onChange={(_e, next) => next && setDays(next)}
            slotProps={{ button: { 'data-testid': 'space-link-expiry-select' } }}
          >
            {SPACE_LINK_EXPIRY_DAYS.map(preset => (
              <Option key={preset} value={preset} data-testid={`space-link-expiry-option-${preset}`}>
                {preset === 1 ? '1 day' : `${preset} days`}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl size="sm" error={capInvalid}>
          <FormLabel>Max joins</FormLabel>
          <Input
            type="number"
            placeholder="No limit"
            value={cap}
            onChange={e => setCap(e.target.value)}
            slotProps={{ input: { 'data-testid': 'space-link-cap-input', min: 1 } }}
            sx={{ width: 120 }}
          />
        </FormControl>
        <FormControl size="sm" error={domainsInvalid} sx={{ flex: 1, minWidth: 180 }}>
          <FormLabel>Allowed email domains</FormLabel>
          <Input
            placeholder="Any (e.g. example.com)"
            value={domains}
            onChange={e => setDomains(e.target.value)}
            slotProps={{ input: { 'data-testid': 'space-link-domains-input' } }}
          />
        </FormControl>
        <Button
          size="sm"
          disabled={capInvalid || domainsInvalid}
          loading={create.isPending}
          onClick={handleCreate}
          data-testid="space-link-create-btn"
        >
          Create link
        </Button>
      </Stack>
      {isError && <Typography color="danger">Invite links could not be loaded.</Typography>}
      <Stack spacing={1} data-testid="space-links-list">
        {links.map(link => {
          const status = linkStatus(link);
          return (
            <Box
              key={link.id}
              data-testid={`space-link-row-${link.id}`}
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
                      size="sm"
                      variant="plain"
                      onClick={() => handleCopy(link)}
                      data-testid={`space-link-copy-${link.id}`}
                    >
                      Copy
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="plain"
                    color="danger"
                    onClick={() => handleRevoke(link)}
                    data-testid={`space-link-revoke-${link.id}`}
                  >
                    Revoke
                  </Button>
                </>
              )}
            </Box>
          );
        })}
      </Stack>
      {hasNextPage && (
        <Button
          variant="outlined"
          loading={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          data-testid="space-links-load-more-btn"
        >
          Load more links
        </Button>
      )}
    </Stack>
  );
};

export default SpaceLinksTab;
