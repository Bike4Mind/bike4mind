import type { ToolContext } from '../base/types';
import { createModelAdmission, loadFreeTierAllowedModels, loadModelConfigurations } from '../../modelAdmission';

export async function createToolModelAdmission(context: ToolContext) {
  const [configs, freeTierAllowedModels] = await Promise.all([
    loadModelConfigurations(context.db.adminSettings),
    loadFreeTierAllowedModels(context.db.adminSettings),
  ]);
  return createModelAdmission({
    user: context.user,
    configs,
    freeTierAllowedModels,
    getEntitlements: async () => context.entitlementKeys ?? [],
  });
}
