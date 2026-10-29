import { withholdAdminRole } from '@server/auth/apiKeyAdminScope';
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

export async function filterAdmittedMediaModels<Model extends { id: string }>(
  user: IUserDocument,
  models: Model[]
): Promise<Model[]> {
  const admission = await createModelAdmission(user);
  const admitted = await Promise.all(models.map(model => admission.admits(model.id)));
  return models.filter((_model, index) => admitted[index]);
}
