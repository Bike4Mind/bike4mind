/** Session (refresh) lifetime. Mirrors the current refresh-token TTL (30d). */
export const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the one-generation-back refresh secret is still accepted after a rotation supersedes it.
 *
 * Presenting a secret inside this window buys an ACCESS token only - it never rotates the chain and
 * never issues a refresh token (see rotateSession), so a replayer gains nothing durable. That is
 * strictly tighter than the previous behaviour, which re-rotated on a replay and handed a replayer
 * a fresh refresh token - meaning a thief and the victim could re-promote each other indefinitely
 * and reuse detection never fired at all.
 *
 * It has to cover two things, both short:
 *  - concurrent siblings (tabs sharing one cookie jar) arriving just after the winner committed;
 *  - a client retry after a rotation response was lost in flight, leaving the client on the old
 *    secret while the server advanced. The client's refresh is bounded at 10s and its caller
 *    re-drives immediately on the next 401, so a couple of minutes is generous.
 *
 * Honest accounting of the two costs of widening this from the original 60s:
 *  - A superseded secret replayed 61-120s after supersession used to revoke the session on the
 *    spot and now returns an access token instead, so the theft alarm is suppressed for an extra
 *    minute.
 *  - Each accepted replay mints an access token whose own lifetime outlives the window, so the
 *    reachable access from one stale secret is this window PLUS one access-token lifetime.
 * MAX_REFRESH_REPLAY_USES below bounds how many such tokens a single secret can mint.
 */
export const REFRESH_REPLAY_WINDOW_MS = 2 * 60 * 1000;

/**
 * How many replays of a superseded secret are served per generation.
 *
 * Without a cap the window bounds only the TIMESPAN of replay, not the count: one stale secret
 * could be presented repeatedly for the full window, minting a fresh access token each time and
 * limited only by the refresh endpoint's per-IP rate limit.
 *
 * Legitimate demand is small. Tabs normally converge without reaching the server at all (the client
 * coordinator holds a cross-tab lock and broadcasts the winner's token), so this path is only taken
 * when that coordination is unavailable or loses a timing race - a handful of siblings in one
 * burst, plus the occasional lost-response retry. Ten leaves generous headroom while removing the
 * unbounded-mint property. Exhausting it rejects that one refresh; it never revokes the session,
 * because a large legitimate burst and abuse look identical here.
 */
export const MAX_REFRESH_REPLAY_USES = 10;
