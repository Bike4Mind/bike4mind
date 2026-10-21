import type { ApiClient } from '../auth/ApiClient';
import { logger } from './Logger';

const probeDecisionModels = async (apiClient: Pick<ApiClient, 'get'>): Promise<boolean> => {
  try {
    const body = await apiClient.get<{ models?: unknown[] }>('/api/v1/decision-models');
    return Array.isArray(body?.models) && body.models.length > 0;
  } catch {
    // Keep provider responses and request credentials out of diagnostics.
    logger.debug('[decide] Decision-model availability lookup failed; hiding the tool until the next build.');
    return false;
  }
};

let decisionModelsProbe: Promise<boolean> | undefined;

/**
 * Whether this deployment serves a decision model this caller can call. The CLI holds no key
 * table of its own - the server resolves the key - so one request is the only honest signal;
 * a failed probe hides the tool rather than offering one that would only 503. A yes is cached
 * for the process (keys rarely appear mid-run); a no is not, so a later build re-checks.
 */
export const hasDecisionModels = (apiClient: Pick<ApiClient, 'get'>): Promise<boolean> =>
  (decisionModelsProbe ??= probeDecisionModels(apiClient).then(available => {
    if (!available) decisionModelsProbe = undefined;
    return available;
  }));
