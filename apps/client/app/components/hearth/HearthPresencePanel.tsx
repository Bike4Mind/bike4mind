import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Chip, Link, Sheet, Stack, Typography } from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { IHearthEventAction, ICcAgentStatus } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
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

/**
 * Caps the roster's share of the column. Rows are per-session and nothing
 * deletes them, so an unbounded panel grows without limit; in this flex column
 * the event stream is the only child that can shrink, so it absorbed all of it
 * and at roughly 20 rows the composer was pushed out of a `100dvh; overflow:
 * hidden` root - clipped rather than scrolled to, leaving no way to post.
 */
const MAX_ROSTER_HEIGHT = '30dvh';

/**
 * Dim for a stale row. Applied to the ROW only: it used to compound with the
 * last-seen line's own 0.6 for an effective 0.36, roughly 2:1 on the soft
 * background and below AA - and it landed on the one element that carries the
 * staleness information. Since rows never expire, stale is the majority state of
 * an aged roster, so this is the common case rather than an edge one.
 */
const STALE_ROW_OPACITY = 0.7;

/**
 * The states that mean a human has to do something. Announced; the rest are not,
 * because a roster of several sessions each reporting per tool call would turn a
 * screen reader into a stream of "is working" with the one actionable line buried
 * in it.
 */
const ATTENTION_STATES: ReadonlySet<PresenceState> = new Set(['awaiting_permission', 'awaiting_input']);

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

  // Keyed on channelId, not []: a timer armed for the previous channel used to
  // survive the switch, fire, and invalidate the OLD query key - swallowing one
  // refresh for the channel the user had just moved to. Reads as flaky presence
  // rather than as a bug, which is why it is worth the dependency.
  useEffect(() => {
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [channelId]);

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
  // Distinct per channel, so two mounted panels cannot both own the same id.
  const headingId = `hearth-presence-heading-${channelId}`;

  const attention = rows.filter(row => ATTENTION_STATES.has(row.state));
  const attentionSummary =
    attention.length === 0
      ? ''
      : `${attention.length} ${attention.length === 1 ? 'session needs' : 'sessions need'} attention: ${attention
          .map(row => `${row.actorName ?? row.actorId} ${STATE_CHIPS[row.state].label.toLowerCase()}`)
          .join(', ')}`;

  return (
    <Sheet
      variant="soft"
      sx={{ p: 1.5, borderRadius: 0, maxHeight: MAX_ROSTER_HEIGHT, overflowY: 'auto' }}
      data-testid="hearth-presence-panel"
    >
      {/* `component` so this is a real heading: Joy's title-sm maps to <p>, which
          left the panel with no landmark to navigate to. */}
      <Typography level="title-sm" component="h3" id={headingId} sx={{ mb: rows.length > 0 ? 1 : 0 }}>
        Who is here
      </Typography>
      {/*
        A transition into "Needs permission" is the one event in this feature that
        is genuinely urgent for a human, and it was announced to nobody. Only the
        actionable states go in the live region, and only their names - the clock
        tick re-renders this component every 30s, and aria-live re-announces on
        CHANGED text, so including lastSeen here would nag on a timer.
      */}
      <Box aria-live="polite" aria-atomic="true" sx={visuallyHidden} data-testid="hearth-presence-announcer">
        {attentionSummary}
      </Box>
      {/*
        Loading and failure must never render as "nobody is here". All three
        collapsed into the empty message before, and the error version was
        STICKY: the global query defaults are retry: false with no refetch on
        focus or reconnect, so one 500 or one post-expiry 401 left the panel
        asserting the channel was empty until a later presence push happened to
        arrive - which a channel full of quiet actors never sends. A wrong claim
        about who is present is worse than admitting we do not know yet.

        Deliberately not `placeholderData: keepPreviousData`: on a channel switch
        that would show the PREVIOUS channel's actors under the new channel's
        heading, trading a momentary blank for a momentary lie.
      */}
      {roster.isPending ? (
        <Typography level="body-xs" sx={{ opacity: 0.7 }} data-testid="hearth-presence-loading">
          Loading presence...
        </Typography>
      ) : roster.isError ? (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography level="body-xs" color="danger" data-testid="hearth-presence-error">
            Could not load presence.
          </Typography>
          {/* The only way back: nothing else retries this query. */}
          <Link
            level="body-xs"
            component="button"
            onClick={() => void roster.refetch()}
            data-testid="hearth-presence-retry-btn"
          >
            Retry
          </Link>
        </Stack>
      ) : rows.length === 0 ? (
        <Typography level="body-xs" sx={{ opacity: 0.7 }} data-testid="hearth-presence-empty">
          No presence reported in this channel yet.
        </Typography>
      ) : (
        <Stack spacing={0.75} role="list" aria-labelledby={headingId}>
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
                role="listitem"
                sx={{ opacity: stale ? STALE_ROW_OPACITY : 1 }}
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
                {/* Full strength when stale: this is the element that explains
                    the dim, so it must not be dimmed by it. */}
                <Typography level="body-xs" sx={{ opacity: stale ? 1 : 0.6 }} data-testid="hearth-presence-last-seen">
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
