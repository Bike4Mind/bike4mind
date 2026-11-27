import { FC, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';
import { ApiKeyScope, SLACK_CHANNEL_ID_PATTERN } from '@bike4mind/common';
import { useCreateUserApiKey } from '@client/app/hooks/data/userApiKeys';
import {
  useGetOrgSlackApiPostingChannels,
  useSetOrgSlackChannelApiPosting,
} from '@client/app/hooks/data/useOrgSlackWorkspace';
import { toast } from 'sonner';

interface OrgSlackApiPostingProps {
  organizationId: string;
  organizationName?: string;
}

const parseKeyIds = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map(id => id.trim())
    .filter(Boolean);

/**
 * Org-owner control for which channels API keys with `slack:post` may post to
 * (POST /api/v1/slack/messages). Off for every channel until enabled here. `slack:post` is a
 * confined scope, so the New-Key modals don't offer it and a posting key is minted here instead.
 */
const OrgSlackApiPosting: FC<OrgSlackApiPostingProps> = ({ organizationId, organizationName }) => {
  const { data: channels, isLoading, isError } = useGetOrgSlackApiPostingChannels(organizationId);
  const setPosting = useSetOrgSlackChannelApiPosting(organizationId);
  const [channelId, setChannelId] = useState('');
  const [keyIds, setKeyIds] = useState('');
  const [inviteHint, setInviteHint] = useState<string | null>(null);
  const [mintedKey, setMintedKey] = useState<{ id: string; key: string } | null>(null);
  const createKey = useCreateUserApiKey({ onSuccess: result => setMintedKey({ id: result.id, key: result.key }) });

  const trimmedChannelId = channelId.trim();
  const channelIdValid = SLACK_CHANNEL_ID_PATTERN.test(trimmedChannelId);

  // The mutation's onError already toasts the failure, so a rejected save just ends here.
  const handleEnable = async () => {
    const saved = await setPosting
      .mutateAsync({ channelId: trimmedChannelId, apiPostEnabled: true, apiPostAllowedKeyIds: parseKeyIds(keyIds) })
      .catch(() => null);
    if (!saved) return;
    setInviteHint(saved.botIsMember === false ? saved.channelId : null);
    setChannelId('');
    setKeyIds('');
    toast.success(`API posting enabled for ${saved.channelId}`);
  };

  const handleDisable = async (id: string) => {
    const saved = await setPosting.mutateAsync({ channelId: id, apiPostEnabled: false }).catch(() => null);
    if (!saved) return;
    if (inviteHint === id) setInviteHint(null);
    toast.success(`API posting disabled for ${id}`);
  };

  return (
    <Stack spacing={1.5} data-testid="org-slack-api-posting">
      <Typography level="title-sm">API posting</Typography>
      <Typography level="body-sm" color="neutral">
        Let API keys with the slack:post scope post to a channel as the bot. Every channel is off until you enable it
        here.
      </Typography>

      {isLoading && <CircularProgress size="sm" />}
      {isError && (
        <Alert color="danger" variant="soft" size="sm">
          Failed to load API posting channels.
        </Alert>
      )}
      {channels && channels.length > 0 && (
        <Stack spacing={1}>
          {channels.map(channel => (
            <Stack key={channel.channelId} direction="row" alignItems="center" justifyContent="space-between" gap={1}>
              <Stack direction="row" alignItems="center" gap={1}>
                <Typography level="body-sm" fontFamily="code">
                  {channel.channelId}
                </Typography>
                <Chip size="sm" variant="soft">
                  {channel.apiPostAllowedKeyIds.length > 0
                    ? `${channel.apiPostAllowedKeyIds.length} key(s) only`
                    : 'Any slack:post key'}
                </Chip>
              </Stack>
              <Button
                data-testid={`org-slack-api-posting-disable-${channel.channelId}`}
                size="sm"
                variant="outlined"
                color="neutral"
                onClick={() => handleDisable(channel.channelId)}
                disabled={setPosting.isPending}
              >
                Disable
              </Button>
            </Stack>
          ))}
        </Stack>
      )}

      {inviteHint && (
        <Alert color="warning" variant="soft" size="sm" data-testid="org-slack-api-posting-invite-hint">
          The bot is not in {inviteHint} yet. Invite it in Slack (/invite @&lt;bot name&gt;) before posting.
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} gap={1} alignItems={{ sm: 'flex-end' }}>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Channel ID</FormLabel>
          <Input
            size="sm"
            placeholder="C0123ABCDEF"
            value={channelId}
            onChange={event => setChannelId(event.target.value)}
            slotProps={{ input: { 'data-testid': 'org-slack-api-posting-channel-input' } }}
          />
        </FormControl>
        <FormControl sx={{ flex: 1 }}>
          <FormLabel>Limit to API key IDs (optional)</FormLabel>
          <Input
            size="sm"
            placeholder="Comma-separated"
            value={keyIds}
            onChange={event => setKeyIds(event.target.value)}
            slotProps={{ input: { 'data-testid': 'org-slack-api-posting-keys-input' } }}
          />
        </FormControl>
        <Box>
          <Button
            data-testid="org-slack-api-posting-enable-btn"
            size="sm"
            onClick={handleEnable}
            disabled={!channelIdValid}
            loading={setPosting.isPending}
          >
            Enable
          </Button>
        </Box>
      </Stack>

      <Stack spacing={1}>
        <Typography level="body-sm" color="neutral">
          A posting key carries only slack:post, so it can do nothing else with your account. Revoke it any time under
          API Keys.
        </Typography>
        {mintedKey ? (
          <Alert color="success" variant="soft" size="sm" data-testid="org-slack-api-posting-minted-key">
            <Stack spacing={0.5}>
              <Typography level="body-sm">
                Copy this key now; it is shown only once. Key ID for the allowlist: {mintedKey.id}
              </Typography>
              <Typography level="body-sm" fontFamily="code" sx={{ wordBreak: 'break-all' }}>
                {mintedKey.key}
              </Typography>
            </Stack>
          </Alert>
        ) : (
          <Box>
            <Button
              data-testid="org-slack-api-posting-create-key-btn"
              size="sm"
              variant="outlined"
              loading={createKey.isPending}
              onClick={() =>
                createKey.mutate({
                  name: `Slack posting (${organizationName ?? organizationId})`,
                  scopes: [ApiKeyScope.SLACK_POST],
                })
              }
            >
              Create posting key
            </Button>
          </Box>
        )}
      </Stack>
    </Stack>
  );
};

export default OrgSlackApiPosting;
