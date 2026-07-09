/**
 * Headless stream-JSON protocol contract.
 *
 * `b4m -p "..." --output-format stream-json` emits one JSON object per line
 * (NDJSON). This module owns that wire contract so CI and other tooling can
 * depend on it: the schema version, the event shapes, and (later milestones)
 * the permission protocol and strict input validation.
 *
 * Human-readable spec: packages/cli/docs/headless-protocol.md. Keep the two in
 * sync - every event type and field documented there must be produced here.
 */

/**
 * Protocol schema version (semver). Bump the MAJOR when removing/renaming a
 * field or event type (breaking change); bump the MINOR when adding an optional
 * field or a new event type (backward-compatible). Consumers should reject a
 * MAJOR they do not understand.
 */
export const HEADLESS_SCHEMA_VERSION = '1.0.0';

/** Every event type the stream-json protocol can emit. */
export type HeadlessEventType = 'thought' | 'action' | 'observation' | 'result' | 'error';

/** An event before the envelope (schemaVersion/runId) is stamped on. */
export type HeadlessEvent = { type: HeadlessEventType } & Record<string, unknown>;

/** A single emitted line: the event plus the stamped protocol envelope. */
export type StampedHeadlessEvent = HeadlessEvent & {
  schemaVersion: string;
  runId: string;
};

/** Serialize an event with the protocol envelope stamped on. Exposed for tests. */
export function stampEvent(runId: string, event: HeadlessEvent): StampedHeadlessEvent {
  // Envelope first, then event fields. Events never carry schemaVersion/runId
  // themselves, so there is no collision.
  return { schemaVersion: HEADLESS_SCHEMA_VERSION, runId, ...event };
}

/**
 * Build an NDJSON emitter that stamps schemaVersion + runId onto every event.
 * `write` receives one serialized line including its trailing newline.
 */
export function createHeadlessEmitter(runId: string, write: (line: string) => void) {
  return (event: HeadlessEvent): void => {
    write(JSON.stringify(stampEvent(runId, event)) + '\n');
  };
}
