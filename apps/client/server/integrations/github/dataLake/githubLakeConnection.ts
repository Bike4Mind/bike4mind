import type { Response } from 'express';
import {
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  isGitHubLakeSyncClaimLive,
  orgGitHubLakeConnectionRepository,
  organizationRepository,
} from '@bike4mind/database';
import {
  GITHUB_LAKE_PLACEHOLDER_NAME,
  acceptsConnectorContent,
  isGitHubDisconnectStalled,
  isLakeIngestable,
  requireEnv,
  type GitHubLakeInstallationChoice,
  type GitHubLakeInstallationPolicyViolation,
  type GitHubLakeRepositoryChoice,
  type GitHubLakeRepositoryChoicesResponse,
  type IDataLakeDocument,
  type IOrgGitHubLakeConnectionDocument,
  type IOrgGitHubLakeConnectionResponse,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { dataLakeService } from '@bike4mind/services';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { createStateToken, verifyStateToken, type BaseStatePayload } from '@server/auth/jwtStateStore';
import { issueStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import {
  assertLakeConnectorFree,
  withConnectionId,
  withLakeConnectorClaim,
} from '@server/dataLakes/assertLakeConnectorFree';
import {
  purgeConnectionIngestedFiles,
  type PurgeConnectionLogger,
} from '@server/dataLakes/purgeConnectionIngestedFiles';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { serializeError } from '@server/utils/serializeError';
import { sendToQueue } from '@server/utils/sqs';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
} from '@server/utils/errors';
import { Resource } from 'sst';
import {
  consumeGitHubLakeAuthGrant,
  GRANT_EXPIRED_MESSAGE,
  readGitHubLakeUserToken,
  requireGitHubLakeFlowNonce,
  storeGitHubLakeAuthGrant,
} from './githubLakeAuthGrant';
import {
  deleteInstallation,
  exchangeInstallerCode,
  getGitHubLakeAppConfig,
  getInstallation,
  gitHubErrorStatus,
  listInstallerVisibleRepositories,
  listUserInstallations,
  type GitHubLakeAppConfig,
  type GitHubLakeUserInstallation,
} from './lakeAppClient';
import { findInstallationPolicyViolation } from './lakeAppPolicy';

export const GITHUB_LAKE_STATE_OPTIONS = { audience: 'github-lake-install-state', expiresIn: '10m' } as const;

/** Files purged per revoke-queue receive (revoke and disconnect alike), sized to finish well inside its 10-minute timeout (infra/queues.ts). */
export const REVOKE_PURGE_SLICE_SIZE = 1000;

/** The githubLakeRevokeQueue message (queueHandlers/githubLakeRevoke.ts parses the same shape). */
export type GitHubLakeRevokeMessage = { connectionId: string; installationId: number };

type GitHubLakeStatePayload = BaseStatePayload & { userId: string; dataLakeId: string };

type LakeUser = { id: string; isAdmin: boolean };

/** Where GitHub returns the browser; must match the client's GITHUB_LAKE_CALLBACK_PATH and a Callback URL registered on the App. */
const GITHUB_LAKE_CALLBACK_PATH = '/data-lakes/github/callback';

const POLICY_MESSAGES: Record<GitHubLakeInstallationPolicyViolation, string> = {
  all_repositories:
    'The GitHub App is installed on all repositories. Change it to "Only select repositories" in the installation settings, then refresh.',
  excess_permissions:
    'The GitHub App installation grants more than read-only repository contents. Reduce its permissions in the installation settings, then refresh.',
  missing_contents_read:
    'The GitHub App installation cannot read repository contents. Accept its requested permissions in the installation settings, then refresh.',
};

/** Model defaults (enabled true, status 'connected') are applied here too, for rows that predate them. */
export function toGitHubLakeConnectionResponse(
  conn: IOrgGitHubLakeConnectionDocument,
  fileCount: number
): IOrgGitHubLakeConnectionResponse {
  return {
    id: conn.id,
    accountLogin: conn.accountLogin,
    repositoryId: conn.repositoryId,
    repositoryFullName: conn.repositoryFullName,
    connectedBy: conn.connectedBy,
    connectedAt: conn.connectedAt,
    enabled: conn.enabled !== false,
    status: conn.status ?? 'connected',
    lastError: conn.lastError ?? null,
    defaultBranch: conn.defaultBranch ?? null,
    lastSyncedAt: conn.lastSyncedAt ?? null,
    syncStale: conn.status === 'syncing' && !isGitHubLakeSyncClaimLive(conn),
    fileCount,
    disconnecting: !!conn.disconnectRequestedAt,
    disconnectStalled: !!conn.disconnectRequestedAt && isGitHubDisconnectStalled(conn.disconnectRequestedAt),
  };
}

export function requireGitHubLakeAppConfig(config: GitHubLakeAppConfig | null): GitHubLakeAppConfig {
  if (!config) {
    throw new InternalServerError('The data-lake GitHub App is not configured on this deployment');
  }
  return config;
}

/**
 * The org lake a user may bind a repository to right now, or a thrown HTTP error saying why not.
 * Runs at every step of the connect (start, authorize return, picker, completion): the flow can take
 * minutes, during which the lake can be archived, re-originated, or connected by someone else.
 */
export async function resolveConnectableLake(user: LakeUser, dataLakeId: string) {
  const lake = await dataLakeRepository.findById(dataLakeId);
  if (!lake) {
    throw new NotFoundError('Data lake not found');
  }
  if (!lake.organizationId) {
    throw new BadRequestError('Connecting a GitHub repository requires an organization-scoped data lake');
  }
  // Org owner/manager (or platform admin) only, matching the Drive connect. Ahead of every other
  // check so a non-member cannot probe the lake's status, origin or connections.
  await verifyOrgAccess(user, lake.organizationId);

  if (!isLakeIngestable(lake.status)) {
    throw new BadRequestError(`Cannot connect a GitHub repository to a data lake in '${lake.status}' status`);
  }
  // Binding never flips origin: the owner declaring the lake connector-fed is the consent (drive-sync.ts).
  if (!acceptsConnectorContent(lake.origin)) {
    throw new BadRequestError(
      `"${lake.name}" is curated. Change its origin to connector-fed in the lake's settings before connecting a GitHub repository.`
    );
  }
  await assertLakeConnectorFree(lake.id, { includeClaim: true });
  return { lakeId: lake.id, organizationId: lake.organizationId };
}

/**
 * Starts a lake connect: the App's OAuth authorize URL, carrying a signed `state` (user + lake) and
 * setting the flow's browser-binding nonce cookie on `res`. Authorize comes first because any GitHub
 * user can approve it, where only an account owner can submit the install page; the user then picks
 * the repository in the app (listGitHubLakeRepositoryChoices). `redirect_uri` returns the browser to
 * this deployment, which only works when its callback URL is registered on the App.
 */
export function buildGitHubLakeAuthorizeUrl(
  res: Response,
  config: GitHubLakeAppConfig,
  params: { userId: string; dataLakeId: string }
): string {
  const nonceHash = issueStateNonce(res, NONCE_SLOT.githubLakeConnect);
  const query = new URLSearchParams({
    client_id: config.clientId,
    state: createStateToken(GITHUB_LAKE_STATE_OPTIONS, params, nonceHash),
    redirect_uri: `${requireEnv('APP_URL', process.env.APP_URL)}${GITHUB_LAKE_CALLBACK_PATH}`,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${query.toString()}`;
}

/**
 * The install fallback, signed into the same flow (nonce) so its return completes like an authorize.
 * The install page takes no return URL: GitHub sends it to the App's FIRST callback URL.
 *
 * With `targetAccountId` it is the "add repositories" link for that account's existing installation:
 * GitHub's targeted install page sends an account owner to that installation's repository access and
 * lets any other org member request the change, which GitHub forwards to every owner (returning
 * `setup_action=request`). The installation's settingsUrl, by contrast, 404s for a non-owner.
 */
function buildGitHubLakeInstallUrl(
  config: GitHubLakeAppConfig,
  nonceHash: string,
  params: { userId: string; dataLakeId: string },
  targetAccountId?: number
): string {
  const query = new URLSearchParams({ state: createStateToken(GITHUB_LAKE_STATE_OPTIONS, params, nonceHash) });
  const base = `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new`;
  if (targetAccountId === undefined) return `${base}?${query.toString()}`;
  query.set('target_id', String(targetAccountId));
  return `${base}/permissions?${query.toString()}`;
}

/**
 * The lake id signed into `state`, once the token, its browser binding and its user all check out.
 * 403, not 401: the client answers a 401 with a session refresh and, failing that, a sign-out.
 */
export function verifyGitHubLakeState(state: string, nonceHash: string | null, userId: string): string {
  const result = verifyStateToken<GitHubLakeStatePayload>(state, GITHUB_LAKE_STATE_OPTIONS, nonceHash);
  if (!result.valid) {
    throw new ForbiddenError(result.message);
  }
  // The completion must be authed as the user who started the flow, not whoever holds the session now.
  if (result.payload.userId !== userId || typeof result.payload.dataLakeId !== 'string') {
    throw new ForbiddenError('Invalid authorization state.');
  }
  return result.payload.dataLakeId;
}

/**
 * The authorize callback (and the install fallback's return): exchanges GitHub's `code` for the
 * user's token and holds it server-side for the repository pick. Returns the lake signed into
 * `state`, so the client can reopen it. Nothing is bound yet.
 */
export async function authorizeGitHubLakeConnection(params: {
  config: GitHubLakeAppConfig;
  user: LakeUser;
  state: string;
  code: string;
  nonceHash: string | null;
}): Promise<{ dataLakeId: string }> {
  const { config, user, state, code } = params;
  const dataLakeId = verifyGitHubLakeState(state, params.nonceHash, user.id);
  const nonceHash = requireGitHubLakeFlowNonce(params.nonceHash);
  // Before the exchange, so a lake that cannot take a connection fails without minting a token.
  const { lakeId } = await resolveConnectableLake(user, dataLakeId);

  let userToken: string;
  try {
    userToken = await exchangeInstallerCode(config, code);
  } catch (error) {
    // serializeError, never the raw error: octokit's HttpError carries the request body, which holds
    // the App's client_secret and the OAuth code.
    Logger.warn('GitHub lake connect: authorization code exchange failed', { error: serializeError(error) });
    throw new BadRequestError('The GitHub authorization expired or was already used. Connect GitHub again.');
  }
  await storeGitHubLakeAuthGrant(config, { nonceHash, userId: user.id, dataLakeId: lakeId, userToken });
  return { dataLakeId: lakeId };
}

/**
 * Runs a GitHub call made with the flow's held user token. A 401 means that token is dead - the user
 * revoked the App's authorization at github.com/settings/applications, or a later authorize in the
 * same flow superseded it - so it is reported as 403, never let through as-is: errorHandler copies a
 * numeric error.status onto the response, and the client's session interceptor treats a 401 as a dead
 * session, signing the user out. The now-useless grant is best-effort released alongside it.
 */
async function withGitHubLakeUserToken<T>(
  config: GitHubLakeAppConfig,
  nonceHash: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (gitHubErrorStatus(error) !== 401) throw error;
    await consumeGitHubLakeAuthGrant(config, nonceHash).catch((consumeError: unknown) =>
      Logger.warn('GitHub lake connect: could not consume the grant for a revoked token', {
        error: serializeError(consumeError),
      })
    );
    throw new ForbiddenError(GRANT_EXPIRED_MESSAGE);
  }
}

/**
 * What the repository picker offers: every installation of the App the user's token can see, its
 * visible repositories annotated with any lake already bound to them, and the install fallback.
 * An installation that breaks the App policy is listed with the reason instead of its repositories.
 */
export async function listGitHubLakeRepositoryChoices(params: {
  config: GitHubLakeAppConfig;
  user: LakeUser;
  dataLakeId: string;
  nonceHash: string | null;
}): Promise<GitHubLakeRepositoryChoicesResponse> {
  const { config, user } = params;
  const nonceHash = requireGitHubLakeFlowNonce(params.nonceHash);
  const { lakeId, organizationId } = await resolveConnectableLake(user, params.dataLakeId);
  const userToken = await readGitHubLakeUserToken(nonceHash, user, lakeId);

  const installations = await withGitHubLakeUserToken(config, nonceHash, () => listUserInstallations(userToken));
  const stateParams = { userId: user.id, dataLakeId: lakeId };
  const installUrl = buildGitHubLakeInstallUrl(config, nonceHash, stateParams);
  const choices = await Promise.all(
    installations.map(installation =>
      toInstallationChoice(config, nonceHash, userToken, installation, organizationId, {
        // Without an account id there is nothing to target; the plain install page still lets the
        // user pick the account there.
        addRepositoriesUrl:
          installation.accountId === null
            ? installUrl
            : buildGitHubLakeInstallUrl(config, nonceHash, stateParams, installation.accountId),
      })
    )
  );
  return { installations: choices, installUrl };
}

async function toInstallationChoice(
  config: GitHubLakeAppConfig,
  nonceHash: string,
  userToken: string,
  installation: GitHubLakeUserInstallation,
  organizationId: string,
  links: { addRepositoriesUrl: string }
): Promise<GitHubLakeInstallationChoice> {
  const { id, accountLogin, accountType, settingsUrl } = installation;
  const { addRepositoriesUrl } = links;
  const violation = findInstallationPolicyViolation(installation);
  if (violation) {
    return {
      id,
      accountLogin,
      accountType,
      settingsUrl,
      addRepositoriesUrl,
      violation: { code: violation, message: POLICY_MESSAGES[violation] },
      repositories: [],
    };
  }
  // Null only if the installation vanished between the two calls; it then offers nothing.
  const repositories =
    (await withGitHubLakeUserToken(config, nonceHash, () => listInstallerVisibleRepositories(userToken, id))) ?? [];
  const boundTo = await resolveRepositoryBindings(
    repositories.map(repo => repo.id),
    organizationId
  );
  return {
    id,
    accountLogin,
    accountType,
    settingsUrl,
    addRepositoriesUrl,
    violation: null,
    repositories: repositories.map((repo): GitHubLakeRepositoryChoice => ({
      ...repo,
      boundTo: boundTo.get(repo.id) ?? null,
    })),
  };
}

/**
 * The lake each already-bound repository feeds, named only when that lake is in the caller's org:
 * the binding is global (a repository feeds one lake platform-wide), its lake's name is not.
 */
async function resolveRepositoryBindings(
  repositoryIds: number[],
  organizationId: string
): Promise<Map<number, NonNullable<GitHubLakeRepositoryChoice['boundTo']>>> {
  const bindings = await orgGitHubLakeConnectionRepository.findByRepositoryIds(repositoryIds);
  const sameOrgLakeIds = [
    ...new Set(bindings.filter(b => b.organizationId === organizationId).map(b => b.targetDataLakeId)),
  ];
  const lakes = await Promise.all(sameOrgLakeIds.map(lakeId => dataLakeRepository.findById(lakeId)));
  const lakeNames = new Map(lakes.flatMap(lake => (lake ? [[lake.id, lake.name] as const] : [])));
  return new Map(
    bindings.map(binding => [
      binding.repositoryId,
      {
        dataLakeName:
          binding.organizationId === organizationId ? (lakeNames.get(binding.targetDataLakeId) ?? null) : null,
      },
    ])
  );
}

/**
 * Binds the repository the user picked to the lake. `installationId` and `repositoryId` come from
 * the browser, so neither is trusted: the repository must be one the flow's user token can see
 * through that installation, which is the ownership proof. The live installation must also be
 * selected-repositories and read-only. On success the flow's grant is consumed and its token revoked.
 */
export async function completeGitHubLakeConnection(params: {
  config: GitHubLakeAppConfig;
  user: LakeUser;
  dataLakeId: string;
  nonceHash: string | null;
  installationId: number;
  repositoryId: number;
  logger: Pick<Logger, 'warn'>;
}): Promise<IOrgGitHubLakeConnectionDocument> {
  const { config, user, installationId, repositoryId, logger } = params;
  const nonceHash = requireGitHubLakeFlowNonce(params.nonceHash);
  const { lakeId, organizationId } = await resolveConnectableLake(user, params.dataLakeId);
  const userToken = await readGitHubLakeUserToken(nonceHash, user, lakeId);

  const visibleRepositories = await withGitHubLakeUserToken(config, nonceHash, () =>
    listInstallerVisibleRepositories(userToken, installationId)
  );
  const repository = visibleRepositories?.find(repo => repo.id === repositoryId);
  if (!repository) {
    throw new ForbiddenError('Your GitHub account cannot access that repository through the data-lake GitHub App.');
  }

  const installation = await getInstallation(config, installationId);
  const violation = findInstallationPolicyViolation(installation);
  if (violation) {
    throw new BadRequestError(POLICY_MESSAGES[violation]);
  }

  let connection: IOrgGitHubLakeConnectionDocument;
  try {
    connection = await withLakeConnectorClaim(lakeId, 'github', claimedId =>
      orgGitHubLakeConnectionRepository.create(
        withConnectionId(claimedId, {
          organizationId,
          targetDataLakeId: lakeId,
          installationId,
          accountLogin: installation.accountLogin,
          repositoryId: repository.id,
          repositoryFullName: repository.fullName,
          connectedBy: user.id,
          connectedAt: new Date(),
        })
      )
    );
  } catch (error) {
    // Unique repositoryId / targetDataLakeId: the repository already feeds a lake, or another connect bound it first.
    if (isDuplicateKeyError(error)) {
      throw new ConflictError('That repository or data lake is already connected. Refresh and pick another.');
    }
    throw error;
  }

  // The binding stands without it: a stale intent only feeds the finish-connect banner, which also
  // hides once a connection exists, and a lake left on the placeholder name can be renamed by hand.
  await nameLakeAfterRepository(lakeId, repository.fullName, user, logger).catch((error: unknown) =>
    logger.warn('GitHub lake connect: could not clear the pending connector or name the lake', {
      connectionId: connection.id,
      error: serializeError(error),
    })
  );
  // The binding stands without it: an unconsumed grant expires on its own TTL.
  await consumeGitHubLakeAuthGrant(config, nonceHash).catch((error: unknown) =>
    logger.warn('GitHub lake connect: could not consume the authorization grant', {
      connectionId: connection.id,
      error: serializeError(error),
    })
  );
  await queueFirstIngest(connection, logger);
  return connection;
}

/**
 * Renames a lake still carrying the connector-first placeholder (POST /api/data-lakes/github-connect)
 * to the bound repository's owner/repo, and clears its pending connector either way. A lake the user
 * already renamed keeps its name; one they named exactly the placeholder is renamed too.
 */
export async function nameLakeAfterRepository(
  lakeId: string,
  repositoryFullName: string,
  user: LakeUser,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  const before = await dataLakeRepository.renameIfPlaceholderAndClearPending(
    lakeId,
    GITHUB_LAKE_PLACEHOLDER_NAME,
    repositoryFullName,
    { lastUpdatedByUserId: user.id }
  );
  if (!before) return;
  // Same grant set and org-admin set the route-driven lake writes resolve, so the audit rung names
  // the grant owner or org admin that made the bind rather than collapsing to creator/system.
  const [grants, administeredOrgIds] = await Promise.all([
    dataLakeService.loadActiveLakeGrants(before, { db: { dataLakeAccessGrants: dataLakeAccessGrantRepository } }),
    user.isAdmin ? Promise.resolve([]) : organizationRepository.findIdsWithAdminRights(user.id),
  ]);
  await dataLakeService.recordLakeConfigChange(
    {
      actor: { userId: user.id, isAdmin: user.isAdmin, administeredOrgIds },
      lake: before,
      grants,
      action: 'update',
      changes: dataLakeService.diffLakeConfig({ name: before.name }, { name: repositoryFullName }),
    },
    { db: lakeConfigAuditDb, logger }
  );
}

/**
 * Best-effort: the binding is valid without it and a manual re-sync runs the same ingest. Inside the
 * try because an unregistered Resource key throws on the property read, before sendToQueue is called.
 */
async function queueFirstIngest(
  connection: IOrgGitHubLakeConnectionDocument,
  logger: Pick<Logger, 'warn'>
): Promise<void> {
  try {
    await sendToQueue(Resource.githubLakeIngestQueue.url, { connectionId: connection.id });
  } catch (error) {
    logger.warn('GitHub lake connect: could not queue the first ingest', { connectionId: connection.id, error });
    // lastError makes the failure visible on the connection (status stays 'connected' so the sync
    // route's isGitHubLakeSyncClaimLive check still accepts a manual re-sync); a later successful
    // sync clears it via recordSynced. Best-effort like the enqueue itself - never fails the connect.
    await orgGitHubLakeConnectionRepository
      .recordLastError(connection.id, 'Initial sync could not be queued. Re-sync to start.')
      .catch(e =>
        logger.warn('GitHub lake connect: could not record the enqueue failure', {
          connectionId: connection.id,
          error: e,
        })
      );
  }
}

/**
 * Releases a connection. The installation is account-wide and may serve other lakes, so the App is
 * uninstalled only with its last binding; otherwise it keeps read access to this repository until
 * the account owner deselects it on GitHub (an App cannot drop one repository from its own install),
 * which `installationRetained` tells the caller. A sole binding uninstalls before its row is deleted
 * so a GitHub failure leaves the connection in place to retry instead of an orphaned install; the
 * concurrent-release branch below cannot, so it hands a failed uninstall to githubLakeRevokeQueue.
 * Every Lambda that can release therefore links that queue (infra/web.ts, infra/queues.ts).
 */
export async function releaseGitHubLakeConnection(
  connection: IOrgGitHubLakeConnectionDocument,
  config: GitHubLakeAppConfig | null
): Promise<{ installationRetained: boolean }> {
  const bindings = await orgGitHubLakeConnectionRepository.findByInstallationId(connection.installationId);
  if (!bindings.some(binding => binding.id !== connection.id)) {
    await deleteInstallation(requireGitHubLakeAppConfig(config), connection.installationId);
    await orgGitHubLakeConnectionRepository.release(connection.id, connection.organizationId);
    return { installationRetained: false };
  }
  await orgGitHubLakeConnectionRepository.release(connection.id, connection.organizationId);
  // Concurrent releases of an installation's last bindings (the revoke queue's installation.deleted
  // fan-out) each see the other and skip the uninstall, so recount after our own delete: the last one
  // out still uninstalls.
  try {
    return { installationRetained: !(await uninstallIfUnbound(connection.installationId, config)) };
  } catch (uninstallError) {
    await deferUninstall(connection, uninstallError);
    // Not retained: the queued revoke finishes the uninstall.
    return { installationRetained: false };
  }
}

/**
 * The row is already gone, so a retried DELETE or lake cleanup would short-circuit before reaching
 * the uninstall; the revoke queue re-enters by installation id instead (revokeGitHubLakeConnection).
 * Rethrows the uninstall error if even the hand-off fails, so the orphaned install is not silent.
 */
async function deferUninstall(connection: IOrgGitHubLakeConnectionDocument, uninstallError: unknown): Promise<void> {
  const message: GitHubLakeRevokeMessage = { connectionId: connection.id, installationId: connection.installationId };
  try {
    await enqueueGitHubLakeRevoke(message);
  } catch (enqueueError) {
    Logger.error('GitHub lake release: could not queue the failed uninstall; the App stays installed unbound', {
      ...message,
      uninstallError,
      enqueueError,
    });
    throw uninstallError;
  }
  Logger.warn('GitHub lake release: uninstall failed after the row was deleted; queued for retry', {
    ...message,
    error: uninstallError,
  });
}

function enqueueGitHubLakeRevoke(message: GitHubLakeRevokeMessage): Promise<unknown> {
  return sendToQueue(Resource.githubLakeRevokeQueue.url, message);
}

/** deleteInstallation treats GitHub's 404 as success, so a repeat call for the same install is safe. */
async function uninstallIfUnbound(installationId: number, config: GitHubLakeAppConfig | null): Promise<boolean> {
  const remaining = await orgGitHubLakeConnectionRepository.findByInstallationId(installationId);
  if (remaining.length > 0) return false;
  await deleteInstallation(requireGitHubLakeAppConfig(config), installationId);
  return true;
}

/**
 * The disconnect door (DELETE github-connection): disables and stamps the connection, then hands the
 * purge and release to githubLakeRevokeQueue, whose consumer (revokeGitHubLakeConnection) is the same
 * teardown run in slices; purge time scales with the repository, so it cannot fit a web request. The
 * row stays as the retry anchor until that consumer releases it. A reconnect mints a new connection
 * id, so a file left behind here would be orphaned in the lake for good. Mirrors drive-connection.ts's
 * DELETE; `queued: false` means a purge is already progressing.
 */
export async function requestGitHubLakeDisconnect(
  connection: IOrgGitHubLakeConnectionDocument,
  logger: PurgeConnectionLogger
): Promise<{ queued: boolean }> {
  // A second message would only start a second self-re-enqueueing chain over the same files.
  if (connection.disconnectRequestedAt && !isGitHubDisconnectStalled(connection.disconnectRequestedAt)) {
    return { queued: false };
  }
  // Paired with claimForSync's `enabled` guard: a live sync would keep minting files past the purge.
  const marked = await orgGitHubLakeConnectionRepository.markDisconnecting(connection.id, connection.organizationId);
  if (!marked) {
    // A concurrent DELETE stamped first; its message is the one purge chain.
    const current = await orgGitHubLakeConnectionRepository.findById(connection.id);
    if (current?.disconnectRequestedAt && !isGitHubDisconnectStalled(current.disconnectRequestedAt)) {
      return { queued: false };
    }
    throw new ConflictError('A sync is in progress for this repository. Try disconnecting again once it finishes.');
  }
  try {
    await enqueueGitHubLakeRevoke({ connectionId: connection.id, installationId: connection.installationId });
  } catch (enqueueError) {
    // No message behind the mark would leave the connection disabled with nothing to finish it. Only
    // the mark's creator undoes it; a stalled retry's re-stamp keeps the pending disconnect.
    if (marked.created) {
      try {
        await orgGitHubLakeConnectionRepository.cancelDisconnect(
          connection.id,
          connection.organizationId,
          marked.stamp,
          marked.previousEnabled
        );
      } catch (cancelError) {
        logger.error('GitHub lake disconnect: could not roll back a disconnect whose purge was not queued', {
          connectionId: connection.id,
          cancelError,
        });
      }
    }
    throw enqueueError;
  }
  return { queued: true };
}

/** Disables (accepting an already-disabled row), then purges one slice; `remaining` asks for another. */
async function disableAndPurgeSlice(
  lake: IDataLakeDocument,
  connection: IOrgGitHubLakeConnectionDocument,
  logger: PurgeConnectionLogger
): Promise<{ remaining: boolean }> {
  // Paired with claimForSync's `enabled` guard: a live sync would keep minting files past the purge.
  const disabled = await orgGitHubLakeConnectionRepository.disableIfNoLiveSyncClaim(
    connection.id,
    connection.organizationId
  );
  if (!disabled) {
    throw new ConflictError('A sync is in progress for this repository. Try disconnecting again once it finishes.');
  }
  // Keeps a user-requested disconnect from reading as stalled while it progresses; no-op for a revoke.
  await orgGitHubLakeConnectionRepository.touchDisconnect(connection.id);
  return purgeConnectionIngestedFiles(
    lake,
    limit =>
      fabFileRepository.findByGitHubConnectionIdInDataLake(connection.id, lake.datalakeTag, {
        includeDeleted: true,
        limit,
      }),
    {
      connectionId: connection.id,
      label: 'GitHub lake disconnect',
      logger,
      sliceSize: REVOKE_PURGE_SLICE_SIZE,
    }
  );
}

/**
 * The githubLakeRevoke queue consumer, fed by the App's webhook (the revoke door) and by
 * requestGitHubLakeDisconnect (the disconnect door), resolved globally because GitHub names an
 * installation, never an org. Idempotent for
 * redeliveries; a live sync's ConflictError is left to throw so SQS retries it. The purge runs in
 * REVOKE_PURGE_SLICE_SIZE slices, re-enqueueing the same message for the rest, so an oversized
 * connection makes progress per receive instead of dead-lettering on its all-or-nothing index removal.
 */
export async function revokeGitHubLakeConnection(
  { connectionId, installationId }: GitHubLakeRevokeMessage,
  logger: PurgeConnectionLogger
): Promise<void> {
  const connection = await orgGitHubLakeConnectionRepository.findById(connectionId);
  if (!connection) {
    // Either a redelivery, or a retry of a concurrent release that deleted the row and then failed
    // its uninstall (releaseGitHubLakeConnection): finish that uninstall if nothing binds it anymore.
    const uninstalled = await uninstallIfUnbound(installationId, getGitHubLakeAppConfig());
    logger.info('GitHub lake revoke: connection already released', { connectionId, installationId, uninstalled });
    return;
  }
  const lake = await dataLakeRepository.findById(connection.targetDataLakeId);
  if (!lake) {
    // The lake's own delete sweep (dataLakeCleanup.ts) owns purging its files; only the
    // connection/installation claim remains to release here.
    await releaseGitHubLakeConnection(connection, getGitHubLakeAppConfig());
    return;
  }
  // No re-enable on a failed purge: the disabled row stays for the SQS retry or the next slice (a
  // revoked App could only fail a sync anyway, and a disconnect was asked for).
  const { remaining } = await disableAndPurgeSlice(lake, connection, logger);
  if (remaining) {
    await enqueueGitHubLakeRevoke({ connectionId, installationId });
    logger.info('GitHub lake revoke: purged a slice; continuing', { connectionId, installationId });
    return;
  }
  await releaseGitHubLakeConnection(connection, getGitHubLakeAppConfig());
}

/**
 * The lake-purge teardown's entry point: releases whatever connection feeds the lake, resolved
 * globally because the lake's org may no longer be resolvable. Null when the lake had none.
 */
export async function releaseGitHubLakeConnectionForLake(
  dataLakeId: string
): Promise<{ installationRetained: boolean } | null> {
  const connection = await orgGitHubLakeConnectionRepository.findByDataLakeIdAny(dataLakeId);
  if (!connection) return null;
  return releaseGitHubLakeConnection(connection, getGitHubLakeAppConfig());
}

/** Archive/delete pause: flips `enabled` only, unlike releaseGitHubLakeConnectionForLake's teardown. */
export async function disableGitHubConnectionForLake(dataLakeId: string): Promise<boolean> {
  return orgGitHubLakeConnectionRepository.setEnabledForLake(dataLakeId, false);
}

export async function enableGitHubConnectionForLake(dataLakeId: string): Promise<boolean> {
  return orgGitHubLakeConnectionRepository.setEnabledForLake(dataLakeId, true);
}
