import { randomBytes } from 'crypto';
import { z } from 'zod';
import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeAccessGrantRepository, dataLakeRepository } from '@bike4mind/database';
import { GITHUB_LAKE_PLACEHOLDER_NAME, type IDataLakeDocument } from '@bike4mind/common';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  buildGitHubLakeAuthorizeUrl,
  requireGitHubLakeAppConfig,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { serializeError } from '@server/utils/serializeError';

const Body = z.object({ organizationId: z.string().trim().min(1) });

export const newPlaceholderSuffix = (): string => randomBytes(4).toString('hex');

/** A slug, datalakeTag or tag-prefix clash on the random suffix - worth one retry with a fresh one. */
function isSuffixCollision(error: unknown): boolean {
  const e = error as { code?: unknown; keyPattern?: Record<string, unknown>; additionalInfo?: { code?: unknown } };
  if (e?.additionalInfo?.code === dataLakeService.TAG_PREFIX_UNAVAILABLE_CODE) return true;
  return e?.code === 11000 && !!e.keyPattern && ('slug' in e.keyPattern || 'datalakeTag' in e.keyPattern);
}

async function createPendingGitHubLake(req: Request, organizationId: string, suffix: () => string) {
  const create = () => {
    const hex = suffix();
    return dataLakeService.createDataLake(
      req.user.id,
      {
        name: GITHUB_LAKE_PLACEHOLDER_NAME,
        slug: `github-repo-${hex}`,
        fileTagPrefix: `gh-${hex}:`,
        origin: 'connector-fed',
      },
      {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          ...lakeConfigAuditDb,
        },
        logger: req.logger,
      },
      organizationId,
      lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo),
      { pendingConnector: 'github' }
    );
  };
  try {
    return await create();
  } catch (error) {
    if (!isSuffixCollision(error)) throw error;
    return create();
  }
}

/**
 * Removes a lake this request just created when its connect never started. The lake is brand new
 * (no files, no connection), so the row and its owner grant are all there is; the `create` audit row
 * stays, as it does for every deleted lake, and ages out on the audit retention window.
 */
async function rollBackPendingLake(req: Request, lake: IDataLakeDocument): Promise<void> {
  const results = await Promise.allSettled([
    dataLakeRepository.delete(lake.id),
    dataLakeAccessGrantRepository.removeAllForLake(lake.id),
  ]);
  for (const result of results) {
    if (result.status === 'rejected') {
      req.logger.error('GitHub lake connect: could not roll back the pending lake', {
        dataLakeId: lake.id,
        error: serializeError(result.reason),
      });
    }
  }
}

/**
 * POST /api/data-lakes/github-connect { organizationId } -> { dataLakeId, authorizeUrl }
 *
 * Connector-first GitHub connect: creates an org lake (draft, connector-fed, placeholder name,
 * pendingConnector github) and starts the same connect as POST /api/data-lakes/:id/github-connection.
 * Every refusal (personal scope, non-manager, flag, missing App config) lands before the insert so a
 * refused request leaves nothing behind. Not an /api/v1 contract route: the flow is cookie-bound.
 */
export function createGitHubConnectHandler(suffix: () => string = newPlaceholderSuffix) {
  return baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
    .use(requireFeatureEnabled('EnableDataLakes'))
    .use(requireFeatureEnabled('EnableDataLakeGitHub'))
    .post(async (req: Request, res: Response) => {
      assertDataLakeWriteScope(req);
      const { organizationId } = Body.parse(req.body);
      await verifyOrgAccess(req.user, organizationId);
      const config = requireGitHubLakeAppConfig(getGitHubLakeAppConfig());

      const lake = await createPendingGitHubLake(req, organizationId, suffix);
      let authorizeUrl: string;
      try {
        authorizeUrl = buildGitHubLakeAuthorizeUrl(res, config, { userId: req.user.id, dataLakeId: lake.id });
      } catch (error) {
        // The nonce cookie is already on the response by the time the state token is signed.
        clearStateNonce(res, NONCE_SLOT.githubLakeConnect);
        await rollBackPendingLake(req, lake);
        throw error;
      }
      return res.json({ dataLakeId: lake.id, authorizeUrl });
    });
}

export const config = {
  api: {
    externalResolver: true,
  },
};

export default createGitHubConnectHandler();
