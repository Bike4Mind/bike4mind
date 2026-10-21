import throttle from 'lodash/throttle.js';

export type StreamingStatusSender = (() => void) & { cancel(): void };

/**
 * Throttled publisher for a turn's streaming status frames.
 *
 * lodash keeps its trailing edge, which is the mid-turn cadence we want - but that trailing
 * call reads the quest at fire time, so it must be dropped with `cancel()` whenever the quest
 * flips to a terminal status. Otherwise it can publish a `done`/`stopped` frame while credit
 * settlement and the terminal save are still in flight.
 */
export function createStreamingStatusSender(
  send: () => unknown,
  intervalMs: number,
  disabled: boolean
): StreamingStatusSender {
  if (disabled) return Object.assign(() => void send(), { cancel: () => {} });
  return throttle(() => void send(), intervalMs, { leading: true });
}
