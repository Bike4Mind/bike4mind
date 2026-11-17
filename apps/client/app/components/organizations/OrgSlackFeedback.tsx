import { useState } from 'react';
import { Button, Input, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';
import { slackFeedbackConfiguredChannelIdSchema } from '@client/app/utils/slackFeedbackIds';

export default function OrgSlackFeedback({
  organizationId,
  canEnable,
}: {
  organizationId: string;
  canEnable: boolean;
}) {
  const path = `/api/organizations/${organizationId}/integrations/slack/feedback`;
  const queryClient = useQueryClient();
  const [channelId, setChannelId] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [emoji, setEmoji] = useState('bug');
  const { data, isError } = useQuery({
    queryKey: ['org-slack', organizationId, 'feedback'],
    queryFn: async () =>
      (
        await api.get<{
          channels: { channelId: string; emoji: string; destinationId: string }[];
          destinations: string[];
        }>(path)
      ).data,
  });
  const mutation = useMutation({
    mutationFn: async (update: { channelId: string; enabled: boolean; destinationId?: string; emoji?: string }) =>
      api.put(path, update),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['org-slack', organizationId, 'feedback'] }),
    onError: () => toast.error('Could not update reaction forwarding.'),
  });
  return (
    <Stack spacing={1} data-testid="org-slack-feedback">
      <Typography level="title-sm">Reaction feedback forwarding</Typography>
      <Typography level="body-sm">
        Off by default. Only a reacted-to message is sent, including author email when available and file names, never
        file contents. No DMs or shared channels. Disconnecting clears all opt-ins.
      </Typography>
      {isError && <Typography color="danger">Could not load forwarding settings.</Typography>}
      <Typography level="body-sm">Provisioned destinations: {data?.destinations.join(', ') || 'None'}</Typography>
      {data?.channels.map(channel => (
        <Stack key={channel.channelId} direction="row" spacing={1}>
          <Typography>
            {channel.channelId}: :{channel.emoji}: to {channel.destinationId}
          </Typography>
          <Button
            data-testid={`slack-feedback-disable-${channel.channelId}`}
            loading={mutation.isPending}
            onClick={() => mutation.mutate({ channelId: channel.channelId, enabled: false })}
          >
            Disable
          </Button>
        </Stack>
      ))}
      {canEnable && (
        <>
          <Input
            data-testid="slack-feedback-channel"
            placeholder="Channel ID (C... or G...)"
            value={channelId}
            onChange={event => setChannelId(event.target.value)}
          />
          <Input
            data-testid="slack-feedback-destination"
            placeholder="Provisioned destination ID"
            value={destinationId}
            onChange={event => setDestinationId(event.target.value)}
          />
          <Input
            data-testid="slack-feedback-emoji"
            placeholder="Emoji name"
            value={emoji}
            onChange={event => setEmoji(event.target.value)}
          />
          <Button
            data-testid="slack-feedback-enable"
            loading={mutation.isPending}
            disabled={
              !slackFeedbackConfiguredChannelIdSchema.safeParse(channelId).success ||
              !data?.destinations.includes(destinationId) ||
              !/^[a-z0-9_+-]{1,64}$/.test(emoji)
            }
            onClick={() => mutation.mutate({ channelId, destinationId, emoji, enabled: true })}
          >
            Enable forwarding for this channel
          </Button>
        </>
      )}
    </Stack>
  );
}
