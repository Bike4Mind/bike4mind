import type { InteractionMode } from '../../../bootstrap/types.js';
import { clampInteractionMode } from '../../../agents/interactionModeClamp.js';
import { getPlanModeFileDir, isWriteTargetingPlanFile } from '../../../utils/planMode.js';
import type { ToolDescriptor } from '../toolDescriptor.js';
import { isReadOnlyTool, writePathOf } from '../toolPolicy.js';

/**
 * The mode this call runs under. Subagents carry a ceiling; clamp to the less-permissive of
 * it and the live mode so they never exceed the parent but still honor a mid-run plan switch.
 */
export async function resolveInteractionMode(override: InteractionMode | undefined): Promise<InteractionMode> {
  const { useCliStore } = await import('../../../store/index.js');
  const liveInteractionMode = useCliStore.getState().interactionMode;
  return override ? clampInteractionMode(liveInteractionMode, override) : liveInteractionMode;
}

/**
 * Plan mode blocks every tool that is not read-only, except a write targeting the plan file.
 * Runs BEFORE the permission/trust check so it overrides previously trusted tools. Returns
 * the model-facing refusal, or null when the call may proceed.
 */
export function planModeRefusal(
  toolName: string,
  descriptor: ToolDescriptor | undefined,
  args: unknown,
  interactionMode: InteractionMode
): string | null {
  if (interactionMode !== 'plan' || isReadOnlyTool(descriptor)) return null;
  if (isWriteTargetingPlanFile(writePathOf(descriptor, args))) return null;
  return `Tool "${toolName}" is blocked while plan mode is active. Plan mode is read-only \u2014 research the codebase, then write your plan to a file under ${getPlanModeFileDir()}/. The user will press Shift+Tab to exit plan mode and authorize execution.`;
}
