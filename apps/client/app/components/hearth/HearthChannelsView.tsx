import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, Input, List, ListItem, ListItemButton, Sheet, Stack, Typography } from '@mui/joy';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { IHearthEventAction } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';

type WireHearthEvent = IHearthEventAction['event'];

interface HearthChannel {
  id: string;
  name: string;
  createdAt: string;
}

/** How many trailing events the view loads on channel select. */
const TAIL_SIZE = 100;

/** Max buffered live events kept per channel (not global, so a burst on one
 * channel can never evict another channel's buffered events). */
const LIVE_CAP_PER_CHANNEL = 500;

function appendLiveEvent(prev: WireHearthEvent[], event: WireHearthEvent): WireHearthEvent[] {
  if (prev.some(e => e.id === event.id)) return prev;
  const next = [...prev, event];
  const inChannel = next.filter(e => e.channelId === event.channelId);
  if (inChannel.length <= LIVE_CAP_PER_CHANNEL) return next;
  const evictId = inChannel[0].id;
  return next.filter(e => e.id !== evictId);
}

function useHearthChannels() {
  return useQuery<HearthChannel[]>({
    queryKey: ['hearth', 'channels'],
    queryFn: async () => (await api.get<{ channels: HearthChannel[] }>('/api/hearth/channels')).data.channels,
  });
}

function useChannelTail(channelId: string | null) {
  return useQuery<WireHearthEvent[]>({
    queryKey: ['hearth', 'tail', channelId],
    enabled: channelId !== null,
    queryFn: async () =>
      (
        await api.post<{ events: WireHearthEvent[] }>('/api/hearth/catchup', {
          channelId,
          tail: TAIL_SIZE,
        })
      ).data.events,
  });
}

/**
 * Minimal Hearth surface: channel list + live event stream + composer.
 * Initial load is a tail read (cursor-less); live updates arrive over the
 * hearth_event WS action and are appended in seq order.
 */
export default function HearthChannelsView() {
  const queryClient = useQueryClient();
  const { subscribeToAction } = useWebsocket();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<WireHearthEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [newChannelName, setNewChannelName] = useState('');

  const channels = useHearthChannels();
  const tail = useChannelTail(selectedId);

  useEffect(() => {
    const unsubscribe = subscribeToAction('hearth_event', async message => {
      const { event } = message as IHearthEventAction;
      setLiveEvents(prev => appendLiveEvent(prev, event));
    });
    return unsubscribe;
  }, [subscribeToAction]);

  const events = useMemo(() => {
    const base = tail.data ?? [];
    const seen = new Set(base.map(e => e.id));
    const merged = [...base, ...liveEvents.filter(e => e.channelId === selectedId && !seen.has(e.id))];
    return merged.sort((a, b) => a.seq - b.seq);
  }, [tail.data, liveEvents, selectedId]);

  const createChannel = useMutation({
    mutationFn: async (name: string) => (await api.post('/api/hearth/channels', { name })).data,
    onSuccess: () => {
      setNewChannelName('');
      queryClient.invalidateQueries({ queryKey: ['hearth', 'channels'] });
    },
  });

  const postMessage = useMutation({
    mutationFn: async (text: string) =>
      (
        await api.post<{ event: WireHearthEvent }>('/api/hearth/events', {
          channelId: selectedId,
          kind: 'message',
          human: { text, format: 'md' },
        })
      ).data.event,
    onSuccess: event => {
      setDraft('');
      // The WS echo may race the HTTP response; the id-dedupe in the merge handles both orders.
      setLiveEvents(prev => appendLiveEvent(prev, event));
    },
  });

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (text && selectedId) postMessage.mutate(text);
  }, [draft, selectedId, postMessage]);

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0 }} data-testid="hearth-view">
      <Sheet variant="soft" sx={{ width: 260, p: 2, overflowY: 'auto' }}>
        <Typography level="title-lg" sx={{ mb: 1 }}>
          Hearth
        </Typography>
        <List size="sm">
          {(channels.data ?? []).map(channel => (
            <ListItem key={channel.id}>
              <ListItemButton
                selected={channel.id === selectedId}
                onClick={() => setSelectedId(channel.id)}
                data-testid="hearth-channel-btn"
              >
                # {channel.name}
              </ListItemButton>
            </ListItem>
          ))}
        </List>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
          <Input
            size="sm"
            placeholder="New channel"
            value={newChannelName}
            onChange={e => setNewChannelName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newChannelName.trim()) createChannel.mutate(newChannelName.trim());
            }}
            data-testid="hearth-new-channel-input"
          />
          <Button
            size="sm"
            variant="outlined"
            disabled={!newChannelName.trim() || createChannel.isPending}
            onClick={() => createChannel.mutate(newChannelName.trim())}
            data-testid="hearth-create-channel-btn"
          >
            +
          </Button>
        </Stack>
      </Sheet>

      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {selectedId === null ? (
          <Box sx={{ m: 'auto', textAlign: 'center' }}>
            <Typography level="body-lg">Select a channel to view its event log.</Typography>
            <Typography level="body-sm" sx={{ mt: 1 }}>
              Every message here is an event in the shared Hearth log - the same stream your CLI agents read with
              hearth_catchup.
            </Typography>
          </Box>
        ) : (
          <>
            <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }} data-testid="hearth-event-list">
              {events.map(event => (
                <Box key={event.id} sx={{ mb: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="baseline">
                    <Typography level="title-sm">{event.actorName ?? event.actorId}</Typography>
                    <Typography level="body-xs" sx={{ opacity: 0.6 }}>
                      #{event.seq} {'\u00B7'} {new Date(event.createdAt).toLocaleTimeString()}
                    </Typography>
                    {event.kind !== 'message' && (
                      <Chip size="sm" variant="soft">
                        {event.kind}
                      </Chip>
                    )}
                  </Stack>
                  <Typography level="body-md" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {event.human.text}
                  </Typography>
                </Box>
              ))}
            </Box>
            <Stack direction="row" spacing={1} sx={{ p: 2, pt: 0 }}>
              <Input
                sx={{ flex: 1 }}
                placeholder="Post to the log..."
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSend();
                }}
                data-testid="hearth-composer-input"
              />
              <Button
                disabled={!draft.trim() || postMessage.isPending}
                onClick={handleSend}
                data-testid="hearth-composer-send-btn"
              >
                Send
              </Button>
            </Stack>
          </>
        )}
      </Box>
    </Box>
  );
}
