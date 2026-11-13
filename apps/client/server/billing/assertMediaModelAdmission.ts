import { withholdAdminRole } from '@bike4mind/server-utils/auth/apiKeyAdminScope';
import type { IUserDocument } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { createModelAdmission } from './meterPlatformCompletion';

/** Shared by media services so API, tool and queue callers enforce the same admission rule. */
export async function assertMediaModelAdmission(
  user: string | IUserDocument,
  modelId: string,
  adminRoleWithheld?: boolean,
  organizationId?: string | null
): Promise<void> {
  const loaded = typeof user === 'string' ? await userRepository.findById(user) : user;
  if (!loaded) throw new NotFoundError('User not found');
  const admission = await createModelAdmission(
    adminRoleWithheld ? withholdAdminRole(loaded) : loaded,
    undefined,
    false,
    {
      organizationId,
    }
  );
  await admission.assert(modelId);
}

export async function filterAdmittedMediaModels<Model extends { id: string }>(
  user: IUserDocument,
  models: Model[],
  organizationId?: string | null
): Promise<Model[]> {
  const admission = await createModelAdmission(user, undefined, false, { organizationId });
  const admitted = await Promise.all(models.map(model => admission.admits(model.id)));
  return models.filter((_model, index) => admitted[index]);
}
