/**
 * How to read a turn's Time To First Visible Token.
 *
 * - `measured`       the user saw text, and firstTokenTime says when.
 * - `never-rendered` the model streamed (firstChunkTime proves it) but nothing ever became
 *                    visible. The frozen-turn case the metric exists to expose.
 * - `unknown`        neither timing was recorded. Usually the turn never streamed at all (a media
 *                    generation, a failure before the first chunk) or it predates the fields - but
 *                    a retry also clears both stamps, so this does not prove nothing streamed.
 *
 * `unknown` is NOT a quieter `never-rendered`. Collapsing the two makes every non-streaming
 * turn look like a frozen one and drowns the signal, so every surface that styles or labels
 * TTFVT branches on this rather than on a truthy test of firstTokenTime alone.
 */
export type TtfvtState = 'measured' | 'never-rendered' | 'unknown';

export function ttfvtState(firstTokenTime?: number, firstChunkTime?: number): TtfvtState {
  if (firstTokenTime) return 'measured';
  if (firstChunkTime) return 'never-rendered';
  return 'unknown';
}
