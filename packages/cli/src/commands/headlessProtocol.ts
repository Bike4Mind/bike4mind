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
 * Raised when a structured headless input is malformed or carries a field
 * outside its allowlist. Headless input fails loud on protocol drift rather
 * than silently ignoring unknown fields.
 */
export class HeadlessInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessInputError';
  }
}

/**
 * Decode a JSON string to a plain object and reject any key outside
 * `allowedKeys`. `inputType` names the input in error messages. Throws
 * HeadlessInputError on invalid JSON, a non-object payload, or an unknown key.
 */
export function parseStrictObject(
  raw: string,
  allowedKeys: readonly string[],
  inputType: string
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (e) {
    throw new HeadlessInputError(`${inputType}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new HeadlessInputError(`${inputType}: expected a JSON object`);
  }
  const allowed = new Set(allowedKeys);
  const unknownKeys = Object.keys(decoded).filter(k => !allowed.has(k));
  if (unknownKeys.length > 0) {
    throw new HeadlessInputError(
      `${inputType}: unknown field(s): ${unknownKeys.join(', ')}. Allowed: ${allowedKeys.join(', ')}`
    );
  }
  return decoded as Record<string, unknown>;
}

/**
 * Decode a JSON string to an array of strings, rejecting any other shape.
 * Used for list-shaped inputs such as the B4M_ADDITIONAL_DIRS bridge.
 */
export function parseStringArray(raw: string, inputType: string): string[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (e) {
    throw new HeadlessInputError(`${inputType}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(decoded) || decoded.some(v => typeof v !== 'string')) {
    throw new HeadlessInputError(`${inputType}: expected a JSON array of strings`);
  }
  return decoded as string[];
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

/** A policy verdict for a single tool: allow it or deny it. */
export type PermissionPolicyAction = 'allow' | 'deny';

/**
 * Declarative permission policy for unattended headless runs. Consulted per
 * gated tool so CI can run without the blanket --dangerously-skip-permissions
 * override. Precedence: deny list > allow list > risk threshold > defaultAction.
 */
export interface HeadlessPermissionPolicy {
  /** Exact tool names always allowed. */
  allow: string[];
  /** Exact tool names always denied; deny wins over allow. */
  deny: string[];
  /** Auto-allow any tool whose risk is at or below this level. Omit to disable. */
  maxAutoAllowRisk?: CommandRiskLevel;
  /** Verdict when no rule matches. Defaults to 'deny' (safe for unattended CI). */
  defaultAction: PermissionPolicyAction;
}

export const HEADLESS_PERMISSION_POLICY_KEYS = ['allow', 'deny', 'maxAutoAllowRisk', 'defaultAction'] as const;

const RISK_RANK: Record<CommandRiskLevel, number> = { low: 0, medium: 1, high: 2 };

function readOptionalStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw new HeadlessInputError(`${label} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Parse and strictly validate a permission policy from its JSON text. Rejects
 * unknown fields and malformed values with HeadlessInputError. Missing lists
 * default to empty and a missing defaultAction defaults to 'deny'.
 */
export function parsePermissionPolicy(raw: string): HeadlessPermissionPolicy {
  const obj = parseStrictObject(raw, HEADLESS_PERMISSION_POLICY_KEYS, 'permission policy');
  const allow = readOptionalStringArray(obj.allow, 'permission policy: allow');
  const deny = readOptionalStringArray(obj.deny, 'permission policy: deny');

  let maxAutoAllowRisk: CommandRiskLevel | undefined;
  if (obj.maxAutoAllowRisk !== undefined) {
    if (obj.maxAutoAllowRisk !== 'low' && obj.maxAutoAllowRisk !== 'medium' && obj.maxAutoAllowRisk !== 'high') {
      throw new HeadlessInputError('permission policy: maxAutoAllowRisk must be one of low|medium|high');
    }
    maxAutoAllowRisk = obj.maxAutoAllowRisk;
  }

  let defaultAction: PermissionPolicyAction = 'deny';
  if (obj.defaultAction !== undefined) {
    if (obj.defaultAction !== 'allow' && obj.defaultAction !== 'deny') {
      throw new HeadlessInputError('permission policy: defaultAction must be one of allow|deny');
    }
    defaultAction = obj.defaultAction;
  }

  return { allow, deny, maxAutoAllowRisk, defaultAction };
}

/** The policy's verdict for one tool invocation, with a human-readable reason. */
export interface PolicyDecision {
  action: PermissionPolicyAction;
  reason: string;
}

/** Evaluate a policy against a tool and its classified risk. Never throws. */
export function evaluatePermissionPolicy(
  policy: HeadlessPermissionPolicy,
  toolName: string,
  riskLevel: CommandRiskLevel
): PolicyDecision {
  if (policy.deny.includes(toolName)) {
    return { action: 'deny', reason: 'tool in policy deny list' };
  }
  if (policy.allow.includes(toolName)) {
    return { action: 'allow', reason: 'tool in policy allow list' };
  }
  if (policy.maxAutoAllowRisk && RISK_RANK[riskLevel] <= RISK_RANK[policy.maxAutoAllowRisk]) {
    return { action: 'allow', reason: `risk ${riskLevel} <= maxAutoAllowRisk ${policy.maxAutoAllowRisk}` };
  }
  return { action: policy.defaultAction, reason: `policy default (${policy.defaultAction})` };
}
