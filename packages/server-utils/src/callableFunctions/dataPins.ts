import { createHash, randomUUID } from 'node:crypto';
import { pipeline, Transform, type Readable } from 'node:stream';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import {
  BadRequestError,
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  canonicalJson,
  isImageServeable,
  toCallableFunctionPublic,
  type CallableFunctionStampData,
  type ICallableFunctionDataPin,
  type ICallableFunctionPublic,
  type IUserDocument,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  artifactRepository,
  callableFunctionRepository,
  fabFileRepository,
  organizationRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { Logger } from '@bike4mind/observability';
import { fabFilesService, scopedSettingsService } from '@bike4mind/services';
import { getFilesStorage } from '../utils/storage/index';
import {
  callableFunctionDataKey,
  callableFunctionDataPrefix,
  callableFunctionDataStagingKey,
  callableFunctionLiveSourcePrefix,
} from './dataKeys';
import { CALLABLE_FUNCTION_SOURCE_LAMBDA_MAX_BYTES } from './fetchSource';

/**
 * Data files pinned to a saved function: copied once by hash under the function's own prefix in the function-data
 * bucket, read by the browser through an owner-only route and by the server runtime through per-call signed links.
 */

/** The bucket the web API function writes (infra/callableFunctionData.ts); unset where there is none. */
export const CALLABLE_FUNCTION_DATA_BUCKET_ENV = 'CALLABLE_FUNCTION_DATA_BUCKET';

/** How long a link signed for one call stays valid: the runtime's start budget plus the download. */
export const CALLABLE_FUNCTION_DATA_LINK_SECONDS = 300;

const MIB = 1024 * 1024;

/**
 * How long a browser read link stays valid; the browser fetches it at once and caches the bytes by hash. The bucket
 * policy refuses the browser role's links past the same age (FUNCTION_DATA_BROWSER_LINK_WINDOW_MS in infra).
 */
export const CALLABLE_FUNCTION_DATA_BROWSER_LINK_SECONDS = 60;

/**
 * The role the web API function assumes to sign browser links (infra/callableFunctionDataPolicy.ts): the only signer
 * whose links the data bucket honors outside the runtime's endpoint. Unset where there is no data bucket.
 */
export const CALLABLE_FUNCTION_DATA_BROWSER_ROLE_ENV = 'CALLABLE_FUNCTION_DATA_BROWSER_ROLE_ARN';

/** The shortest session STS grants; the S3 client re-assumes the role as it nears expiry. */
const BROWSER_ROLE_SESSION_SECONDS = 900;

export type CallableFunctionDataSts = Pick<STSClient, 'send'>;

export type CallableFunctionDataStorage = Pick<
  S3Storage,
  'uploadStream' | 'copy' | 'download' | 'delete' | 'deletePrefix' | 'getSignedUrl' | 'browserSigningOrigin'
>;

/** The files bucket, read once per pin. */
export type CallableFunctionDataSource = Pick<S3Storage, 'getMetadata' | 'getContent'>;

let dataStorage: CallableFunctionDataStorage | undefined;

/**
 * Whether this process can sign links to pinned data: it was given the function-data bucket (infra grants it to the
 * web API function only), or it is self-host, where pins live in the files bucket.
 */
export function callableFunctionDataReachable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[CALLABLE_FUNCTION_DATA_BUCKET_ENV]) || env.B4M_SELF_HOST === 'true';
}

/** The function-data bucket, or the files bucket on a stack without one (local development and self-host). */
export function getCallableFunctionDataStorage(env: NodeJS.ProcessEnv = process.env): CallableFunctionDataStorage {
  const bucket = env[CALLABLE_FUNCTION_DATA_BUCKET_ENV];
  if (!bucket) return getFilesStorage();
  return (dataStorage ??= new S3Storage(bucket));
}

let browserStorage: { key: string; storage: Pick<S3Storage, 'getSignedUrl'> } | undefined;

/** The data bucket as seen by the browser role: its signed links carry that role's session credentials. */
function getBrowserLinkStorage(
  bucket: string,
  roleArn: string,
  sts?: CallableFunctionDataSts
): Pick<S3Storage, 'getSignedUrl'> {
  const assumeRole = async () => {
    const { Credentials } = await (sts ?? new STSClient({})).send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'callable-function-data-browser',
        DurationSeconds: BROWSER_ROLE_SESSION_SECONDS,
      })
    );
    if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
      throw new Error('The browser data role returned no credentials');
    }
    return {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration,
    };
  };
  if (sts) return new S3Storage(bucket, undefined, assumeRole);
  const key = `${bucket}\n${roleArn}`;
  if (browserStorage?.key !== key) browserStorage = { key, storage: new S3Storage(bucket, undefined, assumeRole) };
  return browserStorage.storage;
}

/** sha256 of the pinned files' names and hashes, so case results recorded on other files are never reused. */
export function callableFunctionDataHash(pins: ICallableFunctionDataPin[] | undefined): string | undefined {
  if (!pins?.length) return undefined;
  const entries = pins.map(({ name, sha256 }) => ({ name, sha256 }));
  return createHash('sha256').update(canonicalJson(entries), 'utf8').digest('hex');
}

export const callableFunctionStampData = (pins: ICallableFunctionDataPin[] | undefined): CallableFunctionStampData[] =>
  (pins ?? []).map(({ name, sha256, bytes }) => ({ name, mode: 'pinned', sha256, bytes }));

export interface CallableFunctionDataLimits {
  fileBytes: number;
  totalBytes: number;
}

/** The two data settings at every organization the person is in (their own scope when none); the lowest wins. */
export async function resolveCallableFunctionDataLimits(user: { id: string }): Promise<CallableFunctionDataLimits> {
  const db = { adminSettings: adminSettingsRepository, scopedSettings: scopedSettingsRepository };
  const orgIds = await organizationRepository.findMembershipOrgIds(user.id);
  const scopes =
    orgIds.length > 0
      ? orgIds.map(organizationId => scopedSettingsService.scopeForCaller({ userId: user.id, organizationId }))
      : [scopedSettingsService.scopeForCaller({ userId: user.id })];
  const lowest = async (
    key: 'CallableFunctionDataFileMaxMb' | 'CallableFunctionDataTotalMaxMb',
    fallback: number
  ): Promise<number> => {
    const values = await Promise.all(
      scopes.map(scope =>
        scopedSettingsService.resolveScopedSetting(key, scope, db, { readFailureMode: 'throw' }).then(setting => {
          const value = Number(setting.value);
          return Number.isFinite(value) && value > 0 ? value : fallback;
        })
      )
    );
    return Math.min(...values) * MIB;
  };
  return {
    fileBytes: await lowest('CallableFunctionDataFileMaxMb', CALLABLE_FUNCTION_DATA_LIMITS.defaultFileMb),
    totalBytes: await lowest('CallableFunctionDataTotalMaxMb', CALLABLE_FUNCTION_DATA_LIMITS.defaultTotalMb),
  };
}

/** The most one source fetch can return, which each source holds of the per-function total. */
export const callableFunctionSourceMaxBytes = (limits: CallableFunctionDataLimits): number =>
  Math.min(limits.fileBytes, CALLABLE_FUNCTION_SOURCE_LAMBDA_MAX_BYTES);

const userOwner = (actor: { id: string }) => ({ ownerType: 'user' as const, ownerKey: actor.id });
const notFound = () => new NotFoundError('Tool not found');
const changed = () =>
  new ConflictError('The tool changed since you opened it. Reload it and try again.', { code: 'version_changed' });
export const megabytes = (bytes: number) => `${Math.floor(bytes / MIB)} MB`;

async function readHead(actor: { id: string }, artifactId: string) {
  const artifact = await artifactRepository.findOne({ id: artifactId, userId: actor.id });
  return artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
}

export interface CallableFunctionDataPinInput {
  fileId: string;
  name: string;
}

export interface CallableFunctionDataDeps {
  storage?: CallableFunctionDataStorage;
  source?: CallableFunctionDataSource;
  limits?: CallableFunctionDataLimits;
  now?: Date;
  sts?: CallableFunctionDataSts;
}

/**
 * Copies a file the owner can read into the function's prefix under `name` and returns the function to draft. Refuses
 * an unsafe or taken name, an eleventh file, and a file over the per-file or per-function limit.
 */
export async function pinCallableFunctionData(
  actor: IUserDocument,
  functionId: string,
  input: CallableFunctionDataPinInput,
  deps: CallableFunctionDataDeps = {}
): Promise<ICallableFunctionPublic> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  if (!CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN.test(input.name)) {
    throw new BadRequestError(
      'A data file name is 1 to 64 letters, digits, ".", "_", or "-", starting with a letter or digit.',
      { code: 'data_name_invalid' }
    );
  }
  const pins = fn.pin.dataPins ?? [];
  const sources = fn.sources ?? [];
  if (pins.some(pin => pin.name === input.name) || sources.some(source => source.name === input.name)) {
    throw new ConflictError(`A data file or source named ${input.name} already exists.`, { code: 'data_name_taken' });
  }
  if (pins.length >= CALLABLE_FUNCTION_DATA_LIMITS.maxPins) {
    throw new ConflictError(`A tool can have at most ${CALLABLE_FUNCTION_DATA_LIMITS.maxPins} data files.`, {
      code: 'data_pin_limit',
      limit: CALLABLE_FUNCTION_DATA_LIMITS.maxPins,
    });
  }

  const file = await fabFilesService.assertFabFileAccessById(actor, input.fileId, {
    db: { fabFiles: fabFileRepository },
  });
  if (!file.filePath) {
    throw new BadRequestError('This file has no stored bytes to pin.', { code: 'data_file_empty' });
  }
  if (file.moderationStatus === 'blocked') throw new NotFoundError('File not found');
  // A pending file has not been scanned yet; its bytes are copied only once moderation clears it.
  if (!isImageServeable(file)) {
    throw new ConflictError('This file is still being scanned. Try again shortly.', { code: 'data_file_pending' });
  }

  // The copy outlives the source, so only the actor's own file: a sharer's revoke or erasure must not leave one behind.
  if (file.userId !== actor.id) {
    throw new BadRequestError('Only a file you uploaded can be pinned.', { code: 'data_file_not_owned' });
  }

  const limits = deps.limits ?? (await resolveCallableFunctionDataLimits(actor));
  const pinnedBytes =
    pins.reduce((sum, pin) => sum + pin.bytes, 0) + sources.length * callableFunctionSourceMaxBytes(limits);
  const checkSize = (bytes: number) => {
    if (bytes > limits.fileBytes) {
      throw new BadRequestError(`A data file can be at most ${megabytes(limits.fileBytes)}.`, {
        code: 'data_file_too_large',
        limit: limits.fileBytes,
      });
    }
    if (pinnedBytes + bytes > limits.totalBytes) {
      const total = megabytes(limits.totalBytes);
      throw new BadRequestError(`A tool's data files and sources can add up to at most ${total}.`, {
        code: 'data_total_too_large',
        limit: limits.totalBytes,
      });
    }
  };
  // The recorded size first, then the stored object's own, so an oversize file is refused before any byte is read.
  if (Number.isFinite(file.fileSize)) checkSize(file.fileSize);
  const source = deps.source ?? getFilesStorage();
  const { size } = await source.getMetadata(file.filePath);
  if (size === undefined || !Number.isSafeInteger(size)) {
    throw new BadRequestError('This file has no stored bytes to pin.', { code: 'data_file_empty' });
  }
  checkSize(size);

  // One streamed pass: hashed on the way to a staging key, then copied server-side to its content key.
  const storage = deps.storage ?? getCallableFunctionDataStorage();
  const staging = callableFunctionDataStagingKey(fn.id, randomUUID());
  const hash = createHash('sha256');
  let seen = 0;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > size) return done(new Error('The file grew while it was being pinned.'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  let sha256: string;
  try {
    const body = (await source.getContent(file.filePath)) as Readable;
    // pipeline, not pipe: a source that fails mid-read fails the upload instead of leaving it waiting for bytes.
    const hashed = pipeline(body, counted, () => {});
    await storage.uploadStream(hashed, staging, size, { ContentType: 'application/octet-stream' });
    if (seen !== size) throw new Error('The file changed while it was being pinned.');
    sha256 = hash.digest('hex');
    await storage.copy(staging, callableFunctionDataKey(fn.id, sha256));
  } finally {
    await storage.delete(staging).catch(error => Logger.warn('[CALLABLE_FUNCTION_DATA_STAGING_LEFT]', String(error)));
  }

  const pin: ICallableFunctionDataPin = {
    name: input.name,
    sha256,
    bytes: size,
    sourceFileId: file.id,
    pinnedAt: deps.now ?? new Date(),
  };
  const updated = await callableFunctionRepository.setDataPins(fn.id, userOwner(actor), fn, [...pins, pin]);
  // Never delete on a lost write: another pin may have just committed the same content key. A copy no pin names is
  // removed with the function's prefix (deleteCallableFunction, account purge).
  if (!updated) throw changed();
  return toCallableFunctionPublic(updated, await readHead(actor, fn.pin.artifactId));
}

/** Removes one data file and deletes its copy unless another pin of the function holds the same bytes. */
export async function unpinCallableFunctionData(
  actor: { id: string },
  functionId: string,
  name: string,
  deps: CallableFunctionDataDeps = {}
): Promise<ICallableFunctionPublic> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  const pins = fn.pin.dataPins ?? [];
  const removed = pins.find(pin => pin.name === name);
  if (!removed) throw new NotFoundError('Data file not found');
  const kept = pins.filter(pin => pin !== removed);
  const updated = await callableFunctionRepository.setDataPins(fn.id, userOwner(actor), fn, kept);
  if (!updated) throw changed();
  // Read again: a pin or source pin of the same bytes may have committed since. A failed delete leaves an orphan
  // for the prefix delete; the unpin itself has already happened.
  const fresh = await callableFunctionRepository.findByIdForOwner(fn.id, userOwner(actor));
  const latest = fresh?.pin ?? { dataPins: kept, sourcePins: fn.pin.sourcePins };
  const stillNamed = [...(latest.dataPins ?? []), ...(latest.sourcePins ?? [])].some(
    entry => entry.sha256 === removed.sha256
  );
  if (!stillNamed) {
    try {
      await (deps.storage ?? getCallableFunctionDataStorage()).delete(callableFunctionDataKey(fn.id, removed.sha256));
    } catch (error) {
      Logger.warn('[CALLABLE_FUNCTION_DATA_UNPIN_DELETE_FAILED]', { functionId: fn.id, error: String(error) });
    }
  }
  return toCallableFunctionPublic(updated, await readHead(actor, fn.pin.artifactId));
}

/**
 * Where the owner's browser reads one pinned file for `/data/<name>`: a short-lived link to the data bucket signed by
 * the browser role, a link to the files bucket where there is no data bucket, or, where no link a browser can use
 * can be signed (self-host without a browser endpoint, a data bucket without the role), the read route's bytes.
 */
export async function linkCallableFunctionDataForBrowser(
  actor: { id: string },
  functionId: string,
  name: string,
  deps: CallableFunctionDataDeps = {}
): Promise<{ name: string; sha256: string; bytes: number; url: string }> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  const pin = fn.pin.dataPins?.find(entry => entry.name === name);
  if (!pin) throw new NotFoundError('Data file not found');
  const url = await signCallableFunctionDataBrowserLink(
    fn.id,
    callableFunctionDataKey(fn.id, pin.sha256),
    `/api/callable-functions/${encodeURIComponent(fn.id)}/data/${encodeURIComponent(pin.name)}?bytes=1`,
    deps
  );
  return { name: pin.name, sha256: pin.sha256, bytes: pin.bytes, url };
}

/**
 * A one-minute browser link to one stored object of a function, signed only by the browser reader role, or by
 * storage that can sign for the browser where there is no data bucket; `bytesRoute` where neither can.
 */
export async function signCallableFunctionDataBrowserLink(
  functionId: string,
  key: string,
  bytesRoute: string,
  deps: CallableFunctionDataDeps = {}
): Promise<string> {
  const bucket = process.env[CALLABLE_FUNCTION_DATA_BUCKET_ENV];
  const roleArn = process.env[CALLABLE_FUNCTION_DATA_BROWSER_ROLE_ENV];
  const storage = deps.storage ?? getCallableFunctionDataStorage();
  const signer =
    bucket && roleArn
      ? getBrowserLinkStorage(bucket, roleArn, deps.sts)
      : !bucket && (await storage.browserSigningOrigin())
        ? storage
        : undefined;
  const sign = async (by: Pick<S3Storage, 'getSignedUrl'>) => {
    try {
      return await by.getSignedUrl(key, 'get', {
        audience: 'browser',
        expiresIn: CALLABLE_FUNCTION_DATA_BROWSER_LINK_SECONDS,
        ResponseContentType: 'application/octet-stream',
        ResponseContentDisposition: 'attachment',
        ResponseCacheControl: 'private, no-store',
      });
    } catch (error) {
      // No other signer is tried: a missing browser role or a refused assume leaves the browser with no link.
      Logger.error('[CALLABLE_FUNCTION_DATA_BROWSER_LINK_FAILED]', { functionId, error: String(error) });
      throw new ServiceUnavailableError('Pinned data files cannot be read in the browser right now.', {
        code: 'data_link_unavailable',
      });
    }
  };
  return signer ? sign(signer) : bytesRoute;
}

/** The pinned bytes of one of the owner's functions, served by the read route where no browser link can be signed. */
export async function readCallableFunctionData(
  actor: { id: string },
  functionId: string,
  name: string,
  deps: CallableFunctionDataDeps = {}
): Promise<{ pin: ICallableFunctionDataPin; bytes: Buffer }> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  const pin = fn.pin.dataPins?.find(entry => entry.name === name);
  if (!pin) throw new NotFoundError('Data file not found');
  const bytes = await (deps.storage ?? getCallableFunctionDataStorage()).download(
    callableFunctionDataKey(fn.id, pin.sha256)
  );
  return { pin, bytes };
}

/** What the runtime is told about one data file: where to read it for this call and what it must hash to. */
export interface CallableFunctionDataLink {
  name: string;
  sha256: string;
  bytes: number;
  url: string;
}

/** Short-lived read links for exactly the given function's pins, signed for one call. */
export async function signCallableFunctionDataLinks(
  fn: { id: string; pin: { dataPins?: ICallableFunctionDataPin[] } },
  storage: CallableFunctionDataStorage = getCallableFunctionDataStorage()
): Promise<CallableFunctionDataLink[]> {
  return signCallableFunctionDataEntries(fn.id, fn.pin.dataPins ?? [], storage);
}

/** The same links for stored objects of one function named by key, such as its fetched sources. */
export async function signCallableFunctionDataEntries(
  functionId: string,
  entries: { name: string; sha256: string; bytes: number; key?: string }[],
  storage?: CallableFunctionDataStorage
): Promise<CallableFunctionDataLink[]> {
  if (entries.length === 0) return [];
  const signer = storage ?? getCallableFunctionDataStorage();
  return Promise.all(
    entries.map(async ({ name, sha256, bytes, key }) => ({
      name,
      sha256,
      bytes,
      url: await signer.getSignedUrl(key ?? callableFunctionDataKey(functionId, sha256), 'get', {
        expiresIn: CALLABLE_FUNCTION_DATA_LINK_SECONDS,
      }),
    }))
  );
}

/** Deletes every data object of one function, its live source fetches included. */
export async function deleteCallableFunctionDataObjects(
  functionId: string,
  storage: CallableFunctionDataStorage = getCallableFunctionDataStorage()
): Promise<number> {
  return (
    (await storage.deletePrefix(callableFunctionDataPrefix(functionId))) +
    (await storage.deletePrefix(callableFunctionLiveSourcePrefix(functionId)))
  );
}

/**
 * Account purge: the prefix of every function the account owns and the account's own prefix, reserved for data held
 * per person rather than per function. Runs before the function records are erased, which is how it finds them.
 */
export async function purgeCallableFunctionDataForUser(
  userId: string,
  storage: CallableFunctionDataStorage = getCallableFunctionDataStorage()
): Promise<number> {
  const functions = await callableFunctionRepository.listForOwner({ ownerType: 'user', ownerKey: userId });
  let deleted = 0;
  for (const fn of functions) deleted += await deleteCallableFunctionDataObjects(fn.id, storage);
  deleted += await storage.deletePrefix(callableFunctionDataPrefix(userId));
  return deleted;
}
