import { withholdAdminRole } from '../auth/apiKeyAdminScope';
import type { IUserDocument, ModelBackend } from '@bike4mind/common';
import { userRepository } from '@bike4mind/database';
import { NotFoundError } from '@bike4mind/utils';
import { createModelAdmission } from './meterPlatformCompletion';

/** Shared by media services so API, tool and queue callers enforce the same admission rule. */
export async function assertMediaModelAdmission(
  user: string | IUserDocument,
  modelId: string,
  adminRoleWithheld?: boolean,
  organizationId?: string | null,
  orgModelBackend?: ModelBackend | null
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
  await admission.assert(modelId, { orgModelBackend });
}

/** assertMediaModelAdmission's rule as a yes/no, for a caller that skips a model rather than refusing the request. */
export async function isMediaModelAdmitted(
  userId: string,
  modelId: string,
  adminRoleWithheld?: boolean,
  organizationId?: string | null,
  orgModelBackend?: ModelBackend | null
): Promise<boolean> {
  const loaded = await userRepository.findById(userId);
  if (!loaded) return false;
  const admission = await createModelAdmission(
    adminRoleWithheld ? withholdAdminRole(loaded) : loaded,
    undefined,
    false,
    { organizationId }
  );
  return admission.admits(modelId, { orgModelBackend });
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
