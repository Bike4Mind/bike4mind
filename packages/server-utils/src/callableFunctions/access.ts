import { ForbiddenError } from '@bike4mind/common';
import { adminSettingsRepository, organizationRepository, scopedSettingsRepository } from '@bike4mind/database';
import { scopedSettingsService } from '@bike4mind/services';
import { isFeatureEnabled } from '../middlewares/featureFlag';

/**
 * On when `EnableArtifacts` is on and `EnableCallableFunctions` resolves on for every organization the person is a
 * member of (membership, not the selected organization), or at their own scope when in none, so one organization
 * that resolves off is not overridden by another. Read failures throw.
 */
export async function resolveCallableFunctionsEnabled(user: { id: string }): Promise<boolean> {
  if (!(await isFeatureEnabled('EnableArtifacts'))) return false;
  return resolvesOnForEveryMembership(user, 'EnableCallableFunctions');
}

/** On when callable functions are on and `EnableCallableFunctionsMcp` resolves on by the same every-organization rule. */
export async function resolveCallableFunctionsMcpEnabled(user: { id: string }): Promise<boolean> {
  if (!(await resolveCallableFunctionsEnabled(user))) return false;
  return resolvesOnForEveryMembership(user, 'EnableCallableFunctionsMcp');
}

async function resolvesOnForEveryMembership(
  user: { id: string },
  key: 'EnableCallableFunctions' | 'EnableCallableFunctionsMcp'
): Promise<boolean> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const orgIds = await organizationRepository.findMembershipOrgIds(user.id);
  const scopes =
    orgIds.length > 0
      ? orgIds.map(organizationId => scopedSettingsService.scopeForCaller({ userId: user.id, organizationId }))
      : [scopedSettingsService.scopeForCaller({ userId: user.id })];

  const resolved = await Promise.all(
    scopes.map(scope => scopedSettingsService.resolveScopedSetting(key, scope, db, { readFailureMode: 'throw' }))
  );
  return resolved.every(setting => setting.value === true);
}

/** Whether `EnableCallableFunctions` resolves on for one organization, as its members read it. Read failures throw. */
export async function resolveOrganizationCallableFunctionsEnabled(
  user: { id: string },
  organizationId: string
): Promise<boolean> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const scope = scopedSettingsService.scopeForCaller({ userId: user.id, organizationId });
  const setting = await scopedSettingsService.resolveScopedSetting('EnableCallableFunctions', scope, db, {
    readFailureMode: 'throw',
  });
  return setting.value === true;
}

/** Throws 403 unless callable functions are on for this person (the `assertCustomMcpEnabled` convention). */
export async function assertCallableFunctionsEnabled(user: { id: string }): Promise<void> {
  if (!(await resolveCallableFunctionsEnabled(user))) {
    throw new ForbiddenError('Callable functions are disabled');
  }
}
