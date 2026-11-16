import { withholdAdminRole } from '../auth/apiKeyAdminScope';
import type { IUserDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { createModelAdmission } from './meterPlatformCompletion';

/** Shared by media services so API, tool and queue callers enforce the same admission rule. */
export async function assertMediaModelAdmission(
  user: string | IUserDocument,
  modelId: string,
  adminRoleWithheld?: boolean
): Promise<void> {
  const loaded = typeof user === 'string' ? await userRepository.findById(user) : user;
  if (!loaded) throw new NotFoundError('User not found');
  await (await createModelAdmission(adminRoleWithheld ? withholdAdminRole(loaded) : loaded)).assert(modelId);
}

/** assertMediaModelAdmission's rule as a yes/no, for a caller that skips a model rather than refusing the request. */
export async function isMediaModelAdmitted(
  userId: string,
  modelId: string,
  adminRoleWithheld?: boolean
): Promise<boolean> {
  const loaded = await userRepository.findById(userId);
  if (!loaded) return false;
  return (await createModelAdmission(adminRoleWithheld ? withholdAdminRole(loaded) : loaded)).admits(modelId);
}

export async function filterAdmittedMediaModels<Model extends { id: string }>(
  user: IUserDocument,
  models: Model[]
): Promise<Model[]> {
  const admission = await createModelAdmission(user);
  const admitted = await Promise.all(models.map(model => admission.admits(model.id)));
  return models.filter((_model, index) => admitted[index]);
}
