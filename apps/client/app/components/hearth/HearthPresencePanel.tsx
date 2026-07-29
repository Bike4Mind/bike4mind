import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Chip, Sheet, Stack, Typography } from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IHearthEventAction, ICcAgentStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useActorColor } from './actorColors';

// Reuses the shared code-agent status vocabulary rather than a parallel one,
// so this panel and any other surface rendering agent presence agree on terms.
type PresenceState = ICcAgentStatus;

/** The fields this panel renders; the full wire shape is WireHearthPresence. */
interface PresenceRow {
  actorId: string;
  actorName?: string;
  state: PresenceState;
  reason?: string;
  lastSeen: string;
  workspace?: string;
  tool?: string;
}

interface PresenceResponse {
  presence: PresenceRow[];
  staleAfterMs: number;
}

/**
 * Chip text and color per state. The TEXT is the signal; the color only
 * reinforces it, because the roster has to be readable without color vision.
 */
const STATE_CHIPS: Record<PresenceState, { label: string; color: 'danger' | 'warning' | 'primary' | 'neutral' }> = {
  // Distinct labels: a halted session and a session asking a question need
  // different responses from the human, so the roster must not conflate them.
  awaiting_permission: { label: 'Needs permission', color: 'danger' },
  awaiting_input: { label: 'Needs you', color: 'warning' },
  running: { label: 'Working', color: 'primary' },
  idle: { label: 'Idle', color: 'neutral' },
  disconnected: { label: 'Disconnected', color: 'neutral' },
};

/**
 * Presence is the bulk of real Hearth traffic (several concurrent sessions each
 * reporting per tool call), so refetching on every event would put the roster
 * into a request loop. Leading-edge: the first event refreshes immediately, and
 * anything inside the window collapses into one trailing refresh.
 */
const REFRESH_COALESCE_MS = 1000;

/**
 * How often the relative times re-render. Independent of the data refresh: a
 * roster left open must not keep claiming an actor was seen "just now".
 */
const CLOCK_TICK_MS = 30 * 1000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function formatLastSeen(iso: string, now: number): string {
  const elapsedMs = now - new Date(iso).getTime();
  const minutes = Math.floor(elapsedMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(elapsedMs / 3600000);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(elapsedMs / 86400000)}d ago`;
}

/**
 * The presence roster for a channel: one row per actor, "needs you" first.
 *
 * The order is exactly what the server returned and is never re-sorted here -
 * the roster is an inbox, and every surface reading it must agree on what sits
 * at the top (see hearthRepository.presenceForChannel).
 */
export default function HearthPresencePanel({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const actorColor = useActorColor();
  const { subscribeToAction } = useWebsocket();
  const now = useNow();
  const lastRefreshRef = useRef(0);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const roster = useQuery<PresenceResponse>({
    queryKey: ['hearth', 'presence', channelId],
    queryFn: async () =>
      (await api.get<PresenceResponse>(`/api/hearth/presence?channelId=${encodeURIComponent(channelId)}`)).data,
  });

  const refresh = useCallback(() => {
    const invalidate = () => {
      lastRefreshRef.current = Date.now();
      queryClient.invalidateQueries({ queryKey: ['hearth', 'presence', channelId] });
    };
    const elapsed = Date.now() - lastRefreshRef.current;
    if (elapsed >= REFRESH_COALESCE_MS) {
      invalidate();
      return;
    }
    if (pendingRef.current) return;
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      invalidate();
    }, REFRESH_COALESCE_MS - elapsed);
  }, [queryClient, channelId]);

  useEffect(() => {
    return () => {
      if (pendingRef.current) clearTimeout(pendingRef.current);
    };
  }, []);

  useEffect(() => {
    // Only presence events can change a roster row, so other kinds are ignored
    // rather than costing a refetch.
    const unsubscribe = subscribeToAction('hearth_event', async message => {
      const { event } = message as IHearthEventAction;
      if (event.channelId === channelId && event.kind === 'presence') refresh();
    });
    return unsubscribe;
  }, [subscribeToAction, channelId, refresh]);

  const rows = roster.data?.presence ?? [];
  const staleAfterMs = roster.data?.staleAfterMs;

  return (
    <Sheet variant="soft" sx={{ p: 1.5, borderRadius: 0 }} data-testid="hearth-presence-panel">
      <Typography level="title-sm" sx={{ mb: rows.length > 0 ? 1 : 0 }}>
        Who is here
      </Typography>
      {rows.length === 0 ? (
        <Typography level="body-xs" sx={{ opacity: 0.7 }} data-testid="hearth-presence-empty">
          No presence reported in this channel yet.
        </Typography>
      ) : (
        <Stack spacing={0.75}>
          {rows.map(row => {
            // Falls back to 'running' for an unrecognized state, matching the
            // server-side default: never claim the human's attention on a guess.
            const chip = STATE_CHIPS[row.state] ?? STATE_CHIPS.running;
            // Dimming is a redundant hint only: the relative time next to it is
            // what actually tells the reader how old the row is.
            const stale = staleAfterMs !== undefined && now - new Date(row.lastSeen).getTime() > staleAfterMs;
            return (
              <Stack
                key={row.actorId}
                direction="row"
                spacing={1}
                alignItems="center"
                flexWrap="wrap"
                sx={{ opacity: stale ? 0.6 : 1 }}
                data-testid="hearth-presence-row"
              >
                <Box
                  data-testid="hearth-presence-actor-swatch"
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    flexShrink: 0,
                    backgroundColor: actorColor(row.actorId),
                  }}
                />
                <Typography level="title-sm" data-testid="hearth-presence-actor-name">
                  {row.actorName ?? row.actorId}
                </Typography>
                <Chip size="sm" variant="soft" color={chip.color} data-testid="hearth-presence-state-chip">
                  {chip.label}
                </Chip>
                {row.workspace && (
                  <Typography level="body-xs" data-testid="hearth-presence-workspace">
                    {row.workspace}
                  </Typography>
                )}
                {row.tool && (
                  <Chip size="sm" variant="outlined" data-testid="hearth-presence-tool">
                    {row.tool}
                  </Chip>
                )}
                {row.reason && (
                  <Typography level="body-xs" sx={{ opacity: 0.7 }} data-testid="hearth-presence-reason">
                    {row.reason}
                  </Typography>
                )}
                <Typography level="body-xs" sx={{ opacity: 0.6 }} data-testid="hearth-presence-last-seen">
                  {formatLastSeen(row.lastSeen, now)}
                </Typography>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Sheet>
  );
}
