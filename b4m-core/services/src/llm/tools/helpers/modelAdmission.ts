import { readOrgModelPolicy } from '@bike4mind/common';
import type { ToolContext } from '../base/types';
import { createModelAdmission, loadFreeTierAllowedModels, loadModelConfigurations } from '../../modelAdmission';

export async function createToolModelAdmission(context: ToolContext) {
  const [configs, freeTierAllowedModels, organization] = await Promise.all([
    loadModelConfigurations(context.db.adminSettings),
    loadFreeTierAllowedModels(context.db.adminSettings),
    context.governingOrgModelPolicy === undefined && context.organizationId
      ? context.db.organizations.findById(context.organizationId)
      : null,
  ]);
  return createModelAdmission({
    user: context.user,
    configs,
    freeTierAllowedModels,
    orgModelPolicy:
      context.governingOrgModelPolicy === undefined
        ? readOrgModelPolicy(organization?.modelPolicy)
        : context.governingOrgModelPolicy,
    getOrgModelBackend: modelId => context.availableModels?.find(model => model.id === modelId)?.backend,
    getEntitlements: async () => {
      if (!context.getEntitlements) throw new Error('Tool entitlement resolver is not configured');
      return context.getEntitlements();
    },
  });
}
