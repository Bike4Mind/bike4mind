import { adminSettingsRepository, organizationRepository, scopedSettingsRepository } from '@bike4mind/database';
import { settingsMap } from '@bike4mind/common';
import { scopedSettingsService } from '@bike4mind/services';
import { CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS, CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS } from './runtimeParent';

/**
 * A positive number setting at the lowest of the organizations the person belongs to (as
 * `resolveCallableFunctionsEnabled` reads membership), or at their own scope when in none; `fallback` for a scope
 * whose value is missing or not positive.
 */
async function lowestAcrossOrganizations(
  key: 'CallableFunctionTimeLimitSeconds' | 'CallableFunctionPendingCallLimit',
  user: { id: string },
  fallback: number
): Promise<number> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const orgIds = await organizationRepository.findMembershipOrgIds(user.id);
  const scopes =
    orgIds.length > 0
      ? orgIds.map(organizationId => scopedSettingsService.scopeForCaller({ userId: user.id, organizationId }))
      : [scopedSettingsService.scopeForCaller({ userId: user.id })];
  const values = await Promise.all(
    scopes.map(async scope => {
      const { value } = await scopedSettingsService.resolveScopedSetting(key, scope, db);
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
    })
  );
  return Math.min(...values);
}

/** A person's time limit for one call, in ms: `CallableFunctionTimeLimitSeconds`, lowest across organizations. */
export async function resolveCallableFunctionTimeLimitMs(user: { id: string }): Promise<number> {
  const seconds = await lowestAcrossOrganizations(
    'CallableFunctionTimeLimitSeconds',
    user,
    CALLABLE_FUNCTION_DEFAULT_TIMEOUT_MS / 1000
  );
  return Math.floor(Math.min(seconds * 1000, CALLABLE_FUNCTION_QUEUED_MAX_TIMEOUT_MS));
}

/** How many asynchronous calls a person may have queued or running: `CallableFunctionPendingCallLimit`, lowest. */
export async function resolveCallableFunctionPendingCallLimit(user: { id: string }): Promise<number> {
  const limit = await lowestAcrossOrganizations(
    'CallableFunctionPendingCallLimit',
    user,
    settingsMap.CallableFunctionPendingCallLimit.defaultValue ?? 1
  );
  return Math.max(1, Math.floor(limit));
}
