/**
 * Centralized short-circuit predicates for the client-side intent classifier.
 *
 * Decides whether `useSendMessage` should call `POST /api/ai/classify-intent`
 * for a given send. Every predicate that returns `true` skips the endpoint;
 * routing falls back to the rule-based `routeQuery()`. This module owns the
 * "don't call the LLM" list so future additions land in one place.
 *
 * Lives client-side because every signal is a client-side decision (UI state,
 * model picker, slash command, session opt-out). The server short-circuits
 * its own work via `intentClassifier.enabled` in admin settings.
 */
import { hasExplicitAgentLiteral } from '@bike4mind/common';
import { isImageModel } from './commands';

export { hasExplicitAgentLiteral };

/** Minimum message length below which classification is not worth the round-trip. */
export const MIN_CLASSIFIABLE_LENGTH = 12;
/**
 * Client-side classifier budget, intentionally smaller than the server's
 * `z.string().max(8000)` validation (`pages/api/ai/classify-intent.ts`).
 * Past ~4k chars the rule classifier's `length > 150` and `messageFileIds`
 * indicators have already saturated the score to `'complex'`, so paying for
 * an LLM round-trip yields no routing change.
 */
export const MAX_CLASSIFIABLE_LENGTH = 4000;

export interface ShortCircuitContext {
  /** The raw user message. */
  message: string;
  /** True when the user has the Agent-mode toggle ON for this session. */
  agentToggleEnabled: boolean;
  /** True when the rule-based router detected an agent mention or `@agent` literal. */
  hasAgentMention: boolean;
  /** True when `@agent` literal trigger was detected. */
  hasAgentLiteral: boolean;
  /** Active text/image model id. */
  model: string;
  /** True for a real slash command (e.g. `/gen_image`, `/roll`, `/gen_video`). `/llm` is not real. */
  isRealSlashCommand: boolean;
  /**
   * Set to true once the user dismisses the `AutoRouteBadge` in the current
   * session; preserves the "stop second-guessing my routing" UX without
   * persisting across reloads.
   */
  disableAutoRouteForThisSession: boolean;
  /** Admin orchestrationDefaults.intentClassifier.enabled. Defaults to true. */
  intentClassifierAdminEnabled: boolean;
}

/** Discriminated reason so the caller can log which predicate fired (telemetry). */
export type ShortCircuitReason =
  | 'agent_mention'
  | 'agent_literal'
  | 'agent_toggle'
  | 'message_too_short'
  | 'message_too_long'
  | 'slash_command'
  | 'image_model'
  | 'session_opt_out'
  | 'admin_disabled';

export interface ShortCircuitResult {
  /** True when at least one predicate fired; classifier endpoint should NOT be called. */
  shortCircuit: boolean;
  /** Populated only when `shortCircuit === true`. */
  reason?: ShortCircuitReason;
}

export function evaluateShortCircuits(ctx: ShortCircuitContext): ShortCircuitResult {
  if (!ctx.intentClassifierAdminEnabled) return { shortCircuit: true, reason: 'admin_disabled' };
  if (ctx.disableAutoRouteForThisSession) return { shortCircuit: true, reason: 'session_opt_out' };
  if (ctx.isRealSlashCommand) return { shortCircuit: true, reason: 'slash_command' };
  if (ctx.hasAgentLiteral) return { shortCircuit: true, reason: 'agent_literal' };
  if (ctx.hasAgentMention) return { shortCircuit: true, reason: 'agent_mention' };
  if (ctx.agentToggleEnabled) return { shortCircuit: true, reason: 'agent_toggle' };
  if (isImageModel(ctx.model)) return { shortCircuit: true, reason: 'image_model' };
  if (ctx.message.length < MIN_CLASSIFIABLE_LENGTH) return { shortCircuit: true, reason: 'message_too_short' };
  if (ctx.message.length > MAX_CLASSIFIABLE_LENGTH) return { shortCircuit: true, reason: 'message_too_long' };
  return { shortCircuit: false };
}
