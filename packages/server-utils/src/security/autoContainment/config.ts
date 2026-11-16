import { AutoContainmentConfigSchema, type AutoContainmentConfig } from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';

// Lives beside deviceLinkEvaluation.ts rather than in the workers executor because apps/client
// (linked-account evidence) reads the same policy and must not import apps/workers.
export const loadAutoContainmentConfig = async (): Promise<AutoContainmentConfig> => {
  const settings = await getSettingsMap(
    { adminSettings: adminSettingsRepository },
    { names: ['autoContainmentConfig'], skipCache: true }
  );
  return getSettingsValue('autoContainmentConfig', settings, AutoContainmentConfigSchema.parse({}));
};
