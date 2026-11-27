import { dirname } from 'node:path';
import { MANAGED_SETTINGS_PATH } from '../main/chat/permissions/ClaudeCodeSettings';
import { permissionProtectedLocations, toolProtectedLocations } from '../main/chat/protectedLocations';
import type { HostEnvironment, HostProtection } from './ports';

/**
 * The protected folders for a runtime on this machine. Built once and shared: the app's
 * permission service and the runtime's tools must agree on the same set.
 */
export function hostProtectedLocations(
  environment: Pick<HostEnvironment, 'dataDirectory' | 'homeDirectory'>,
  logger: { warn(message: string): void }
): HostProtection {
  return {
    permission: permissionProtectedLocations(
      environment.dataDirectory,
      environment.homeDirectory,
      dirname(MANAGED_SETTINGS_PATH),
      logger
    ),
    tool: toolProtectedLocations(environment.dataDirectory, logger),
  };
}
