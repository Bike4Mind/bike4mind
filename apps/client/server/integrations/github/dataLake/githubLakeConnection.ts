import type { Response } from 'express';
import {
  dataLakeRepository,
  fabFileRepository,
  isGitHubLakeSyncClaimLive,
  orgGitHubLakeConnectionRepository,
} from '@bike4mind/database';
import {
  acceptsConnectorContent,
  isGitHubDisconnectStalled,
  isLakeIngestable,
  type IDataLakeDocument,
  type IOrgGitHubLakeConnectionDocument,
  type IOrgGitHubLakeConnectionResponse,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { createStateToken, verifyStateToken, type BaseStatePayload } from '@server/auth/jwtStateStore';
import { issueStateNonce, NONCE_SLOT } from '@server/auth/oauthFlowCookie';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { assertLakeConnectorFree } from '@server/dataLakes/assertLakeConnectorFree';
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
  UnauthorizedError,
} from '@server/utils/errors';
import { Resource } from 'sst';
import {
  deleteInstallation,
  exchangeInstallerCode,
  getGitHubLakeAppConfig,
  getInstallation,
  listInstallerVisibleRepositories,
  revokeInstallerToken,
  type GitHubLakeAppConfig,
} from './lakeAppClient';
import {
  findInstallationPolicyViolation,
  pickRepositoryToBind,
  type InstallationPolicyViolation,
} from './lakeAppPolicy';

export const GITHUB_LAKE_STATE_OPTIONS = { audience: 'github-lake-install-state', expiresIn: '10m' } as const;

/** Files purged per revoke-queue receive (revoke and disconnect alike), sized to finish well inside its 10-minute timeout (infra/queues.ts). */
export const REVOKE_PURGE_SLICE_SIZE = 1000;

/** The githubLakeRevokeQueue message (queueHandlers/githubLakeRevoke.ts parses the same shape). */
export type GitHubLakeRevokeMessage = { connectionId: string; installationId: number };

type GitHubLakeStatePayload = BaseStatePayload & { userId: string; dataLakeId: string };

type LakeUser = { id: string; isAdmin: boolean };

const POLICY_MESSAGES: Record<InstallationPolicyViolation, string> = {
  all_repositories:
    'The GitHub App was installed on all repositories. Change it to "Only select repositories" and pick the one to connect.',
  excess_permissions:
    'The GitHub App installation grants more than read-only repository contents. Review and reduce its permissions on GitHub, then connect again.',
  missing_contents_read:
    'The GitHub App installation cannot read repository contents. Accept its requested permissions on GitHub, then connect again.',
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
 * Runs at install start AND again at completion: the install round-trip can take minutes, during
 * which the lake can be archived, re-originated, or connected by someone else.
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
  await assertLakeConnectorFree(lake.id);
  return { lakeId: lake.id, organizationId: lake.organizationId };
}

export type GitHubLakeConnectUrls = { installUrl: string; authorizeUrl: string };

/**
 * The two GitHub URLs a lake connect can need, sharing one signed `state` (user + lake) and one
 * per-flow browser-binding nonce cookie set on `res`.
 *
 * installUrl picks the repository. On a fresh install GitHub returns `installation_id` AND `code`
 * (the App requests user authorization on install). When the App is already installed on the
 * account - the second lake fed from the same GitHub org - GitHub shows the existing installation's
 * configure page and returns `installation_id` with no `code`; the callback page then sends the
 * browser through authorizeUrl (silent for a user who already authorized the App) to get the `code`
 * that proves who is completing it, and relays both to POST /api/data-lakes/github-callback.
 */
export function buildGitHubLakeConnectUrls(
  res: Response,
  config: GitHubLakeAppConfig,
  params: { userId: string; dataLakeId: string }
): GitHubLakeConnectUrls {
  const nonceHash = issueStateNonce(res, NONCE_SLOT.githubLakeConnect);
  const state = createStateToken(GITHUB_LAKE_STATE_OPTIONS, params, nonceHash);
  const installQuery = new URLSearchParams({ state });
  const authorizeQuery = new URLSearchParams({ client_id: config.clientId, state, allow_signup: 'false' });
  return {
    installUrl: `https://github.com/apps/${encodeURIComponent(config.slug)}/installations/new?${installQuery.toString()}`,
    authorizeUrl: `https://github.com/login/oauth/authorize?${authorizeQuery.toString()}`,
  };
}

/** The lake id signed into `state`, once the token, its browser binding and its user all check out. */
export function verifyGitHubLakeState(state: string, nonceHash: string | null, userId: string): string {
  const result = verifyStateToken<GitHubLakeStatePayload>(state, GITHUB_LAKE_STATE_OPTIONS, nonceHash);
  if (!result.valid) {
    throw new UnauthorizedError(result.message);
  }
  // The completion must be authed as the user who started the flow, not whoever holds the session now.
  if (result.payload.userId !== userId || typeof result.payload.dataLakeId !== 'string') {
    throw new UnauthorizedError('Invalid authorization state.');
  }
  return result.payload.dataLakeId;
}

/** The installation's repositories the installer can see; the user token is revoked either way. */
async function listReposVisibleToInstaller(config: GitHubLakeAppConfig, code: string, installationId: number) {
  let userToken: string;
  try {
    userToken = await exchangeInstallerCode(config, code);
  } catch (error) {
    // serializeError, never the raw error: octokit's HttpError carries the request body, which holds
    // the App's client_secret and the OAuth code.
    Logger.warn('GitHub lake install: authorization code exchange failed', { error: serializeError(error) });
    throw new BadRequestError('The GitHub authorization expired or was already used. Connect the repository again.');
  }
  try {
    return await listInstallerVisibleRepositories(userToken, installationId);
  } finally {
    await revokeInstallerToken(config, userToken).catch((error: unknown) => {
      // Not fatal: the token was minted for this check alone and expires on its own (8h).
      Logger.warn('GitHub lake install: could not revoke the verification user token', {
        error: serializeError(error),
      });
    });
  }
}

/**
 * Binds the repository chosen during the App install to the lake signed into the flow's state.
 *
 * `installationId` and `code` arrive from the browser, so neither is trusted: the code proves which
 * GitHub user completed the install, and only an installation that user can see is accepted. The
 * live installation must be selected-repositories and read-only, and exactly one of its visible
 * repositories must still be unbound.
 */
export async function completeGitHubLakeConnection(params: {
  config: GitHubLakeAppConfig;
  user: LakeUser;
  dataLakeId: string;
  installationId: number;
  code: string;
  logger: Pick<Logger, 'warn'>;
}): Promise<IOrgGitHubLakeConnectionDocument> {
  const { config, user, dataLakeId, installationId, code, logger } = params;
  const { lakeId, organizationId } = await resolveConnectableLake(user, dataLakeId);

  const visibleRepositories = await listReposVisibleToInstaller(config, code, installationId);
  if (!visibleRepositories) {
    throw new ForbiddenError('You do not have access to that GitHub App installation.');
  }

  const installation = await getInstallation(config, installationId);
  const violation = findInstallationPolicyViolation(installation);
  if (violation) {
    throw new BadRequestError(POLICY_MESSAGES[violation]);
  }

  const bound = await orgGitHubLakeConnectionRepository.findByInstallationId(installationId);
  const pick = pickRepositoryToBind(visibleRepositories, new Set(bound.map(conn => conn.repositoryId)));
  if (pick.kind === 'none_unbound') {
    throw new BadRequestError(
      'Every repository this GitHub App installation can read is already connected to a data lake. Add the repository to connect under the installation\'s "Only select repositories" on GitHub.'
    );
  }
  if (pick.kind === 'ambiguous') {
    throw new BadRequestError(
      `The GitHub App installation can read ${pick.unboundCount} repositories that are not connected yet. Leave only the one to connect selected on GitHub, then connect again.`
    );
  }

  let connection: IOrgGitHubLakeConnectionDocument;
  try {
    connection = await orgGitHubLakeConnectionRepository.create({
      organizationId,
      targetDataLakeId: lakeId,
      installationId,
      accountLogin: installation.accountLogin,
      repositoryId: pick.repository.id,
      repositoryFullName: pick.repository.fullName,
      connectedBy: user.id,
      connectedAt: new Date(),
    });
  } catch (error) {
    // Unique repositoryId / targetDataLakeId: a concurrent connect won the claim after our checks.
    if (isDuplicateKeyError(error)) {
      throw new ConflictError('That repository or data lake was just connected by another request');
    }
    throw error;
  }

  // Best-effort: the binding is valid without it and a manual re-sync runs the same ingest. Inside the try
  // because an unregistered Resource key throws on the property read, before sendToQueue is called.
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
  return connection;
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
