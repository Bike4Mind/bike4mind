/** Session (refresh) lifetime. Mirrors the current refresh-token TTL (30d). */
export const DEFAULT_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long the one-generation-back refresh secret is still accepted after a rotation supersedes it.
 *
 * Presenting a secret inside this window buys an ACCESS token only - it never rotates the chain and
 * never issues a refresh token (see rotateSession). So the window's blast radius is one
 * access-token lifetime, not continued session access, which is what it was before: the previous
 * behaviour re-rotated on a replay, handing a replayer a durable credential.
 *
 * It has to cover two things, both short:
 *  - concurrent siblings (tabs sharing one cookie jar) arriving just after the winner committed;
 *  - a client retry after a rotation response was lost in flight, leaving the client on the old
 *    secret while the server advanced. The client's refresh is bounded at 10s and its caller
 *    re-drives immediately on the next 401, so a couple of minutes is generous.
 */
export const REFRESH_REPLAY_WINDOW_MS = 2 * 60 * 1000;
