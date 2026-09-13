/**
 * Admin API for Tier 1 Secrets Status
 *
 * GET /api/admin/system-secrets/tier1-status
 *
 * Returns configuration status of Tier 1 infrastructure secrets.
 * These secrets cannot be configured via the admin GUI - they must be set using SST CLI.
 *
 * Reports the same set that infra/secrets.ts refuses to deploy on, from the same
 * TIER1_SECRET_SPECS registry, so this page and the deploy gate can never disagree
 * about which secrets matter or about what counts as configured.
 *
 * Security:
 * - Admin-only access
 * - Never returns actual secret values
 * - Only returns status: configured, placeholder, invalid, missing, warning, or insecure
 */

import { Resource } from 'sst';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import {
  evaluateTier1Secrets,
  PRODUCTION_STAGES,
  type Tier1Enforcement,
  type ValidationStatus,
  type ValidationSeverity,
} from '@bike4mind/infra';

interface Tier1SecretInfo {
  name: string;
  status: ValidationStatus;
  severity: ValidationSeverity;
  message?: string;
  hint?: string;
  enforcement: Tier1Enforcement;
  /** True when a deploy of this stage would be refused for this secret. */
  blocksDeploy: boolean;
}

interface Tier1StatusResponse {
  stage: string;
  secrets: Tier1SecretInfo[];
}

/**
 * Config carries the four boot secrets; the rest are read straight off Resource.
 * Accessing an unlinked Resource property throws in the getter itself, so `?.`
 * cannot guard it - a stage that stops linking one of these would otherwise 500
 * the whole page instead of reporting that one secret as unset.
 */
function readLinkedSecret(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

const SECRET_READERS: Record<string, () => string | undefined> = {
  MONGODB_URI: () => Config.MONGODB_URI,
  SESSION_SECRET: () => Config.SESSION_SECRET,
  JWT_SECRET: () => Config.JWT_SECRET,
  SECRET_ENCRYPTION_KEY: () => Config.SECRET_ENCRYPTION_KEY,
  CHAT_COMPLETION_INTERNAL_SECRET: () => readLinkedSecret(() => Resource.CHAT_COMPLETION_INTERNAL_SECRET.value),
  SECOPS_ZAP_INGEST_TOKEN: () => readLinkedSecret(() => Resource.SECOPS_ZAP_INGEST_TOKEN.value),
  SECOPS_CODE_INGEST_TOKEN: () => readLinkedSecret(() => Resource.SECOPS_CODE_INGEST_TOKEN.value),
  SECOPS_PACKAGES_INGEST_TOKEN: () => readLinkedSecret(() => Resource.SECOPS_PACKAGES_INGEST_TOKEN.value),
  SECOPS_SECRETS_INGEST_TOKEN: () => readLinkedSecret(() => Resource.SECOPS_SECRETS_INGEST_TOKEN.value),
  SECOPS_PROWLER_INGEST_TOKEN: () => readLinkedSecret(() => Resource.SECOPS_PROWLER_INGEST_TOKEN.value),
  SECOPS_ATTACK_SIMULATION_INGEST_TOKEN: () =>
    readLinkedSecret(() => Resource.SECOPS_ATTACK_SIMULATION_INGEST_TOKEN.value),
  RATE_LIMIT_INGEST_TOKEN: () => readLinkedSecret(() => Resource.RATE_LIMIT_INGEST_TOKEN.value),
};

function getTier1Status(stage: string): Tier1SecretInfo[] {
  return evaluateTier1Secrets({
    stage,
    isProductionStage: PRODUCTION_STAGES.includes(stage),
    read: name => SECRET_READERS[name]?.(),
  }).map(({ isValid: _isValid, exposure: _exposure, ...info }) => info);
}

const handler = baseApi().get(async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const stage = Config.STAGE;
    const secrets = getTier1Status(stage);

    const response: Tier1StatusResponse = {
      stage,
      secrets,
    };

    return res.json(response);
  } catch (error) {
    Logger.error('Error fetching Tier 1 secrets status:', error);
    if (error instanceof ForbiddenError) {
      return res.status(403).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to fetch Tier 1 secrets status' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
