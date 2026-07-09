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

import { classifyCommandRisk, type CommandRiskLevel } from '../config/commandRisk.js';
import { type ToolCategory } from '../config/toolSafety.js';

/**
 * Protocol schema version (semver). Bump the MAJOR when removing/renaming a
 * field or event type (breaking change); bump the MINOR when adding an optional
 * field or a new event type (backward-compatible). Consumers should reject a
 * MAJOR they do not understand.
 */
export const HEADLESS_SCHEMA_VERSION = '1.0.0';

/** Every event type the stream-json protocol can emit. */
export type HeadlessEventType =
  'thought' | 'action' | 'observation' | 'permission_request' | 'permission_decision' | 'result' | 'error';

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

/**
 * Tools whose risk depends on their command text rather than the tool name.
 * Must stay in sync with SHELL_LIKE_TOOL_COMMAND_FIELDS in utils/toolsAdapter.ts,
 * which is the interactive permission gate's copy of the same mapping.
 */
const SHELL_LIKE_COMMAND_FIELDS: Record<string, string> = {
  bash_execute: 'command',
};

/** A tool invocation's risk, surfaced in permission events. */
export interface ToolRiskAssessment {
  level: CommandRiskLevel;
  reasons: string[];
}

/**
 * Classify the risk of a single tool invocation for the permission protocol.
 * Shell-like tools are classified from their actual command text (reusing the
 * shared command-risk tokenizer); every other tool falls back to a level derived
 * from its permission category (auto_approve -> low, prompt_always -> high, else
 * medium). Never throws: a classifier failure fails closed at `high`.
 */
export function classifyToolRisk(toolName: string, args: unknown, category: ToolCategory): ToolRiskAssessment {
  const field = SHELL_LIKE_COMMAND_FIELDS[toolName];
  const command =
    field && args !== null && typeof args === 'object' ? (args as Record<string, unknown>)[field] : undefined;

  if (typeof command === 'string') {
    try {
      return classifyCommandRisk(command);
    } catch {
      return { level: 'high', reasons: ['command risk analysis failed (fail closed)'] };
    }
  }

  const level: CommandRiskLevel =
    category === 'auto_approve' ? 'low' : category === 'prompt_always' ? 'high' : 'medium';
  return { level, reasons: [] };
}
