import { adminSettingsRepository, organizationRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import { CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS, CALLABLE_FUNCTION_LIMITS } from './runtimeParent';

/**
 * A person's time limit for one call, in ms: `CallableFunctionTimeLimitSeconds` at the lowest of the organizations
 * they belong to (as `resolveCallableFunctionsEnabled` reads membership), or at their own scope when in none.
 */
export async function resolveCallableFunctionTimeLimitMs(user: { id: string }): Promise<number> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const orgIds = await organizationRepository.findMembershipOrgIds(user.id);
  const scopes =
    orgIds.length > 0
      ? orgIds.map(organizationId => scopedSettingsService.scopeForCaller({ userId: user.id, organizationId }))
      : [scopedSettingsService.scopeForCaller({ userId: user.id })];
  const seconds = await Promise.all(
    scopes.map(async scope => {
      const { value } = await scopedSettingsService.resolveScopedSetting('CallableFunctionTimeLimitSeconds', scope, db);
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? value * 1000
        : CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS;
    })
  );
  return Math.floor(Math.min(...seconds, CALLABLE_FUNCTION_LIMITS.timeoutMs));
}
