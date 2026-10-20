import type { ToolCatalog } from '../tools/gateway/toolCatalog.js';
import type { PermissionPromptKind } from '../tools/gateway/gatewayTypes.js';
import { logger } from '../utils/Logger';
import {
  buildPermissionRequestEvent,
  classifyToolRisk,
  resolveHeadlessPermissionDecision,
  type HeadlessEvent,
  type HeadlessPermissionPolicy,
} from './headlessProtocol.js';

export type HeadlessPromptDeps = {
  catalog: ToolCatalog;
  dangerouslySkipPermissions: boolean;
  permissionPolicy: HeadlessPermissionPolicy | null;
  /** The stream-json emitter, or null for the text/json formats. */
  emit: ((event: HeadlessEvent) => void) | null;
  /** Where a non-streaming deny is reported. */
  warn: (message: string) => void;
};

/**
 * The headless permission prompt. Every gated tool surfaces a structured permission_request +
 * permission_decision pair on the stream (so decisions are never silent), then resolves the
 * decision from resolveHeadlessPermissionDecision's precedence ladder.
 */
export function createHeadlessPromptFn(deps: HeadlessPromptDeps) {
  const { catalog, dangerouslySkipPermissions, permissionPolicy, emit, warn } = deps;
  return (
    toolName: string,
    args: unknown,
    _preview?: string,
    kind?: PermissionPromptKind
  ): Promise<{ action: 'allow-once' | 'allow-session' | 'allow-always' | 'deny' }> => {
    const risk = classifyToolRisk(catalog.resolve(toolName), args);
    emit?.(buildPermissionRequestEvent(toolName, risk, kind));

    const decision = resolveHeadlessPermissionDecision({
      dangerouslySkipPermissions,
      isDirectoryGrant: kind === 'directory-grant',
      isSandboxEscalation: kind === 'sandbox-escalation',
      toolName,
      riskLevel: risk.level,
      permissionPolicy,
    });

    if (emit) {
      emit({
        type: 'permission_decision',
        toolName,
        action: decision.action,
        reason: decision.reason,
        risk: risk.level,
        // Echoed so a decision can be matched to its request when a tool question and a
        // sandbox-escalation question for the same tool arrive back to back.
        kind: kind ?? 'tool',
      });
    } else if (decision.action === 'deny') {
      warn(
        kind === 'sandbox-escalation'
          ? `Warning: Tool "${toolName}" was denied by the OS sandbox, and retrying it outside the sandbox ` +
              `needs approval that headless mode cannot grant. Use --dangerously-skip-permissions to allow it.\n`
          : `Warning: Tool "${toolName}" requires permission and was denied (${decision.reason}). ` +
              `Grant it via --permission-policy, or --dangerously-skip-permissions to allow all tools.\n`
      );
    }

    if (decision.action === 'allow-once') {
      logger.debug(`[headless] Auto-allowing tool: ${toolName}`);
    }
    return Promise.resolve({ action: decision.action });
  };
}
