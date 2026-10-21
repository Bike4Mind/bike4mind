import { PermissionDeniedError } from '@bike4mind/common';
import type { PermissionResponse } from '../../../components/PermissionPrompt.js';
import type { PermissionManager } from '../../../utils/PermissionManager.js';
import { isHostAllowlisted } from './hostAllowlist.js';
import type { InteractionMode } from '../../../bootstrap/types.js';

export type AutoRunInput = {
  toolName: string;
  /** A gate (high-risk command, fuzzy edit) demanded an explicit prompt; nothing below may skip it. */
  forcePrompt: boolean;
  isSandboxed: boolean;
  interactionMode: InteractionMode;
  permissionManager: PermissionManager;
};

/**
 * Whether the call runs without a prompt: host-allowlisted, auto-approved / trusted / sandbox
 * auto-allowed, or auto-accept mode (Shift+Tab). A forced prompt overrides all three.
 */
export function canRunWithoutPrompt(input: AutoRunInput): boolean {
  const { toolName, forcePrompt, isSandboxed, interactionMode, permissionManager } = input;
  // Evaluated before the forcePrompt check so the allowlist is parsed on the first call, as
  // it always has been.
  const hostAllowlisted = isHostAllowlisted(toolName);
  if (forcePrompt) return false;
  if (hostAllowlisted) return true;
  if (!permissionManager.needsPermission(toolName, { isSandboxed })) return true;
  return interactionMode === 'auto-accept';
}

/**
 * Apply the user's answer to a permission prompt: deny throws, allow-session trusts the tool for
 * the session, allow-always persists the trust. Every non-deny answer lets the call run.
 */
export async function applyPromptResponse(
  toolName: string,
  rawArgs: unknown,
  action: PermissionResponse,
  permissionManager: PermissionManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configStore: any // any: ConfigStore has dynamic shape, no shared interface
): Promise<void> {
  if (action === 'deny') {
    throw new PermissionDeniedError(toolName, rawArgs);
  }
  if (action === 'allow-session') {
    permissionManager.trustToolForSession(toolName);
  }
  if (action === 'allow-always') {
    await persistToolTrust(toolName, permissionManager, configStore);
  }
}

/**
 * Persist an "allow-always" trust decision to project-local or global config.
 *
 * Only writes the repo's project-local layer when the folder is TRUSTED. An
 * untrusted root never re-reads those layers (computeMerged gates on trust), so
 * persisting there would silently lose the decision on the next launch AND drop a
 * .bike4mind/local.json into a repo the user just declined to trust. Untrusted
 * (the default) falls back to the global layer, which is always honored.
 */
export async function persistToolTrust(
  toolName: string,
  permissionManager: PermissionManager,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configStore: any // any: ConfigStore has dynamic shape, no shared interface
): Promise<void> {
  const canTrust = permissionManager.trustTool(toolName);
  if (!canTrust) return;

  const projectDir = configStore.getProjectConfigDir();
  if (projectDir && configStore.isProjectTrusted()) {
    try {
      await configStore.initProjectConfig();
      const existingLocal = (await configStore.loadRawProjectLocalConfig()) || {};
      await configStore.saveProjectLocalConfig({
        ...existingLocal,
        trustedTools: [...(existingLocal.trustedTools || []), toolName],
      });
      return;
    } catch {
      // Fall back to global if local persistence fails.
    }
  }
  await configStore.trustTool(toolName);
}
