import { ForbiddenError } from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import { isFeatureEnabled } from '../middlewares/featureFlag';

/**
 * On when `EnableArtifacts` is on and `EnableCallableFunctions` resolves on for any organization the person is a
 * member of (membership, not the selected organization), or at their own scope when in none. Read failures throw.
 */
export async function resolveCallableFunctionsEnabled(user: { id: string }): Promise<boolean> {
  if (!(await isFeatureEnabled('EnableArtifacts'))) return false;

  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const orgIds = await organizationRepository.findMembershipOrgIds(user.id);
  const scopes =
    orgIds.length > 0
      ? orgIds.map(organizationId => scopedSettingsService.scopeForCaller({ userId: user.id, organizationId }))
      : [scopedSettingsService.scopeForCaller({ userId: user.id })];

  const resolved = await Promise.all(
    scopes.map(scope =>
      scopedSettingsService.resolveScopedSetting('EnableCallableFunctions', scope, db, { readFailureMode: 'throw' })
    )
  );
  return resolved.some(setting => setting.value === true);
}

/** Throws 403 unless callable functions are on for this person (the `assertCustomMcpEnabled` convention). */
export async function assertCallableFunctionsEnabled(user: { id: string }): Promise<void> {
  if (!(await resolveCallableFunctionsEnabled(user))) {
    throw new ForbiddenError('Callable functions are disabled');
  }
}
