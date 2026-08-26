/**
 * Public projection of a quest's structured tool payloads.
 *
 * Tools that produce machine-readable state emit a `__uiSideEffect` envelope; the tool wrapper
 * (b4m-core/services/src/llm/sharedToolBuilder.ts) hands the payload to `onUiSideEffect` and
 * returns only the terse `displayMessage` to the model, so the payload survives ONLY on
 * `quest.uiSideEffects`. That field was named for its first consumer (the client dispatcher) but
 * the data is not UI-specific, and a programmatic caller needs it to act on a turn - take a
 * structured identifier and submit it onward, or walk the returned steps - instead of re-parsing
 * prose. `toolPayloads` is the API-facing name for exactly that data.
 *
 * This is an ADDITION, never a replacement: the prose reply stays as-is (the streamed-prose /
 * tool-argument split is deliberate - see sharedToolBuilder). Every REST route that returns a
 * turn's result routes through {@link toToolPayloads} so the wire shape has one definition.
 */

/** One structured payload emitted by a tool during a turn. */
export type ToolPayload = {
  /**
   * Discriminator telling a caller how to read `payload`. Allowlisted server-side
   * (`VALID_SIDE_EFFECT_TYPES` in sharedToolBuilder), so an unknown value here means the caller's
   * vocabulary is older than the server's - skip the entry rather than guessing at its shape.
   */
  type: string;
  payload: unknown;
};

/** Loose shape of a persisted `quest.uiSideEffects` entry (Mongoose types `payload` as Mixed). */
type PersistedUiSideEffect = { type?: unknown; payload?: unknown };

/**
 * Project `quest.uiSideEffects` into the public `toolPayloads` array.
 *
 * Builds fresh objects rather than passing the stored array through: persisted entries are
 * Mongoose array subdocuments, so serializing them directly would publish an `_id` per entry and
 * make Mongo internals part of the API surface. Order is preserved (it is emission order, which a
 * caller walking multi-step output depends on).
 *
 * Entries missing a string `type` or a payload are dropped - the server allowlist means they
 * should not exist, so a malformed one is a legacy/partial document, not something a caller can
 * act on. Returns `[]` for null/undefined so callers can iterate without a presence check.
 */
export function toToolPayloads(uiSideEffects: readonly PersistedUiSideEffect[] | null | undefined): ToolPayload[] {
  if (!uiSideEffects?.length) return [];
  const payloads: ToolPayload[] = [];
  for (const effect of uiSideEffects) {
    if (typeof effect?.type !== 'string' || effect.payload == null) continue;
    payloads.push({ type: effect.type, payload: effect.payload });
  }
  return payloads;
}
