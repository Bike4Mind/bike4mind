import { Request, Response } from 'express';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { Resource } from 'sst';

/**
 * Simple endpoint to check LiveOps Triage environment status.
 * Used by AdminPage to determine if the LiveOps Triage tab should be shown.
 * Returns quickly without doing full health checks.
 *
 * Tab visibility rules:
 * - Source deployments (IS_SOURCE_DEPLOYMENT=true): main staging + main production
 * - PR preview environments (stage starts with 'pr'): for testing
 * - Local development (IS_LOCAL=true): for development
 * - Fork deployments: HIDDEN (cannot act on alerts, wrong GitHub repo)
 */
const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req: Request, res: Response) => {
  // Check if user is admin
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  const stage = Resource.App.stage;

  // IS_SOURCE_DEPLOYMENT identifies main/source deployments (bike4mind staging + production).
  // Fork deployments do NOT have it set, so the tab is hidden from them. It is read off the
  // Resource proxy, which throws when the secret is unlinked - hence the assertion and catch.
  let isSourceDeployment = false;
  try {
    const resource = Resource as unknown as Record<string, { value?: string } | undefined>;
    isSourceDeployment = resource.IS_SOURCE_DEPLOYMENT?.value === 'true';
  } catch {
    // Secret not configured - treat as fork/non-source deployment
  }

  // PR preview environments (stages like 'pr6756') - allow for testing
  const isPreviewEnvironment = stage.startsWith('pr');

  // Local development (sst dev sets IS_LOCAL=true)
  const isLocalDevelopment = process.env.IS_LOCAL === 'true';

  const isForkProduction = stage === 'production' && !isSourceDeployment;

  return res.json({
    stage,
    isForkProduction,
    isSourceDeployment,
    isPreviewEnvironment,
    isLocalDevelopment,
    // Tab shown on: source deployments, PR previews, or local development
    showTab: isSourceDeployment || isPreviewEnvironment || isLocalDevelopment,
  });
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
