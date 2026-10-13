import { randomBytes } from 'crypto';
import { z } from 'zod';
import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_WRITE_SCOPES, assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeAccessGrantRepository, dataLakeRepository, organizationRepository } from '@bike4mind/database';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  GITHUB_LAKE_PLACEHOLDER_NAME,
  HTTPError,
  type IDataLakeDocument,
} from '@bike4mind/common';
import { getGitHubLakeAppConfig } from '@server/integrations/github/dataLake/lakeAppClient';
import {
  buildGitHubLakeAuthorizeUrl,
  requireGitHubLakeAppConfig,
  resolveConnectableLake,
} from '@server/integrations/github/dataLake/githubLakeConnection';
import { clearStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { assertLakeConnectorFree } from '@server/dataLakes/assertLakeConnectorFree';
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
 * The caller's earlier, still-unbound placeholder lake in this org, so a retried or abandoned connect
 * does not pile up another one. Null when there is none or it can no longer take a connection.
 */
async function findReusablePendingLake(req: Request, organizationId: string): Promise<IDataLakeDocument | null> {
  const lake = await dataLakeRepository.findPendingPlaceholderLake(
    req.user.id,
    organizationId,
    'github',
    GITHUB_LAKE_PLACEHOLDER_NAME
  );
  if (!lake) return null;
  try {
    // A bind whose best-effort pending-connector clear failed still matches the finder.
    await resolveConnectableLake(req.user, lake.id);
    return lake;
  } catch (error) {
    if (!(error instanceof HTTPError)) throw error;
    // A live claim with no connector row yet is another tab mid-bind on this lake: that bind clears the
    // marker if it succeeds, and the lake is reusable again if it fails, so keep it marked.
    if (error instanceof ConflictError && !(await isBoundToConnector(lake.id))) {
      throw new ConflictError('A GitHub connect for this data lake is already in progress. Try again shortly.');
    }
    // Unmark it so the finder can move on to a lake that can still connect instead of every retry inserting.
    await dataLakeRepository.clearPendingConnector(lake.id);
    return null;
  }
}

const isBoundToConnector = (lakeId: string): Promise<boolean> =>
  assertLakeConnectorFree(lakeId).then(
    () => false,
    (error: unknown) => {
      if (error instanceof ConflictError) return true;
      throw error;
    }
  );

/**
 * Removes a lake this request just created when its connect never started. The lake is brand new
 * (no files, no connection), so the row and its owner grant are all there is. The audit history is
 * append-only, so a `delete` event follows the `create` row instead of the row being removed.
 */
async function rollBackPendingLake(req: Request, lake: IDataLakeDocument): Promise<void> {
  const [lakeResult, grantResult] = await Promise.allSettled([
    dataLakeRepository.delete(lake.id),
    dataLakeAccessGrantRepository.removeAllForLake(lake.id),
  ]);
  for (const result of [lakeResult, grantResult]) {
    if (result.status === 'rejected') {
      req.logger.error('GitHub lake connect: could not roll back the pending lake', {
        dataLakeId: lake.id,
        error: serializeError(result.reason),
      });
    }
  }
  if (lakeResult.status !== 'fulfilled') return;
  // Same admin-org set the bind-time rename resolves, so the audit rung matches the caller's real rights.
  const administeredOrgIds = req.user.isAdmin
    ? []
    : await organizationRepository.findIdsWithAdminRights(req.user.id).catch((error: unknown) => {
        req.logger.warn('GitHub lake connect: could not load admin orgs for the rollback audit', {
          dataLakeId: lake.id,
          error: serializeError(error),
        });
        return [];
      });
  await dataLakeService.recordLakeConfigChange(
    {
      actor: {
        userId: req.user.id,
        isAdmin: !!req.user.isAdmin,
        administeredOrgIds,
        auditPrincipal: lakeConfigAuditPrincipal(req.user!, req.apiKeyInfo),
      },
      lake,
      action: 'delete',
      changes: dataLakeService.diffLakeConfig(lake, { ...lake, status: 'deleted' }),
    },
    { db: lakeConfigAuditDb, logger: req.logger }
  );
}

/**
 * POST /api/data-lakes/github-connect { organizationId } -> { dataLakeId, authorizeUrl }
 *
 * Connector-first GitHub connect: creates an org lake (draft, connector-fed, placeholder name,
 * pendingConnector github), or reuses the caller's own unbound one in that org, and starts the same
 * connect as POST /api/data-lakes/:id/github-connection. Every refusal (API key, personal scope,
 * non-manager, flag, missing App config) lands before the insert so a refused request leaves nothing
 * behind. Session-only and not an /api/v1 contract route: the flow is bound to a browser nonce cookie.
 */
export function createGitHubConnectHandler(suffix: () => string = newPlaceholderSuffix) {
  return baseApi({ requiredScopes: DATA_LAKE_WRITE_SCOPES })
    .use(requireFeatureEnabled('EnableDataLakes'))
    .use(requireFeatureEnabled('EnableDataLakeGitHub'))
    .post(async (req: Request, res: Response) => {
      assertDataLakeWriteScope(req);
      // An API key can never finish the connect (no browser to carry the nonce cookie back).
      if (req.apiKeyInfo) {
        throw new ForbiddenError('Connecting a GitHub repository requires a signed-in session, not an API key');
      }
      const body = Body.safeParse(req.body);
      if (!body.success) {
        throw new BadRequestError('organizationId is required: a GitHub data lake must belong to an organization');
      }
      const { organizationId } = body.data;
      await verifyOrgAccess(req.user, organizationId);
      const config = requireGitHubLakeAppConfig(getGitHubLakeAppConfig());

      let reused = await findReusablePendingLake(req, organizationId);
      let lake = reused ?? (await createPendingGitHubLake(req, organizationId, suffix));
      if (!reused) {
        // A double-click can make two connects both miss the finder and both insert. Re-reading converges them on
        // the lowest-_id lake, best-effort only: there is no unique index and _id order is not insert order.
        // An older lake that another tab started binding meanwhile is not ours to converge on, so keep this one.
        const oldest = await findReusablePendingLake(req, organizationId).catch((error: unknown) => {
          if (error instanceof ConflictError) return null;
          throw error;
        });
        if (oldest && oldest.id !== lake.id) {
          await rollBackPendingLake(req, lake);
          lake = reused = oldest;
        }
      }
      let authorizeUrl: string;
      try {
        authorizeUrl = buildGitHubLakeAuthorizeUrl(res, config, { userId: req.user.id, dataLakeId: lake.id });
      } catch (error) {
        // The nonce cookie is already on the response by the time the state token is signed.
        clearStateNonce(res, NONCE_SLOT.githubLakeConnect);
        if (!reused) await rollBackPendingLake(req, lake);
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
