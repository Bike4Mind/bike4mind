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
 * It has to cover concurrent siblings (tabs sharing one cookie jar) arriving just after the
 * winner committed - the burst case where serving an access token WITHOUT rotating is what lets
 * N callers converge on the winner's token.
 *
 * Since recovery rotation landed (see rotateSession), this window no longer gates revocation:
 * presenting the previous secret AFTER it closes now recovers the chain (the successor's response
 * provably never arrived) instead of revoking the session. So the window only separates "burst -
 * coalesce, do not fork" from "lost response - rotate forward from what the client actually
 * holds". It must comfortably exceed one in-flight response lifetime (the client aborts at 10s),
 * and 2 minutes is that with margin.
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

/**
 * Hard ceiling on one session's total lifetime, measured from its createdAt.
 *
 * expiresAt SLIDES to now + DEFAULT_REFRESH_TTL_MS on every TRUE rotation (see rotateSession), so
 * an actively used session never dies mid-work - the 30d default is an IDLE timeout, not a total
 * lifetime. Recoveries deliberately do NOT slide, so a superseded secret can never hold a row open
 * past the idle deadline its last real rotation set. This cap is what bounds the total: a session
 * that never re-authenticates is forced back through login within 90 days no matter how active it
 * is. Enforced server-side only; the refresh cookie's Max-Age keeps mirroring the idle window (see
 * refreshCookie.ts).
 */
export const ABSOLUTE_SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How many recoveries are served between true rotations (see rotateSession case 3).
 *
 * A genuine lost rotation response needs exactly ONE recovery: the recovered token is delivered and
 * the client rotates normally from then on. The cap matters because recovery leaves
 * `previousRefreshTokenHash` pinned (siblings still holding it must coalesce, not fork), so the
 * presented secret satisfies the recovery CAS again every time the grace window lapses - unbounded,
 * that makes one superseded secret a renewable credential rather than a single self-destructing
 * shot. Three tolerates a couple of consecutively-lost responses, which is already a remote
 * compound failure, while cutting a replay loop off within minutes.
 *
 * Exhausting it does NOT revoke: a legitimate run of lost responses and a replay loop are
 * indistinguishable here, so this degrades to "try again" (429) exactly like the replay allowance
 * above. The attempt is recorded as `refresh_recovery_capped`. Only rotateHash clears the counter,
 * so escaping the cap requires proving possession of the CURRENT secret.
 */
export const MAX_SESSION_RECOVERIES = 3;
