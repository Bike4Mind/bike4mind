import { createHash } from 'node:crypto';
import {
  BadRequestError,
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN,
  ConflictError,
  NotFoundError,
  canonicalJson,
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
import { fabFilesService, scopedSettingsService } from '@bike4mind/services';
import { getFilesStorage } from '../utils/storage/index';
import { callableFunctionDataKey, callableFunctionDataPrefix } from './dataKeys';

/**
 * Data files pinned to a saved function: copied once by hash under the function's own prefix in the function-data
 * bucket, read by the browser through an owner-only route and by the server runtime through per-call signed links.
 */

/** The bucket the web API function writes (infra/callableFunctionData.ts); unset where there is none. */
export const CALLABLE_FUNCTION_DATA_BUCKET_ENV = 'CALLABLE_FUNCTION_DATA_BUCKET';

/** How long a link signed for one call stays valid: the runtime's start budget plus the download. */
export const CALLABLE_FUNCTION_DATA_LINK_SECONDS = 300;

const MIB = 1024 * 1024;

export type CallableFunctionDataStorage = Pick<
  S3Storage,
  'upload' | 'download' | 'delete' | 'deletePrefix' | 'getSignedUrl'
>;

let dataStorage: CallableFunctionDataStorage | undefined;

/** The function-data bucket, or the files bucket on a stack without one (local development and self-host). */
export function getCallableFunctionDataStorage(env: NodeJS.ProcessEnv = process.env): CallableFunctionDataStorage {
  const bucket = env[CALLABLE_FUNCTION_DATA_BUCKET_ENV];
  if (!bucket) return getFilesStorage();
  return (dataStorage ??= new S3Storage(bucket));
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

const userOwner = (actor: { id: string }) => ({ ownerType: 'user' as const, ownerKey: actor.id });
const notFound = () => new NotFoundError('Tool not found');
const changed = () =>
  new ConflictError('The tool changed since you opened it. Reload it and try again.', { code: 'version_changed' });
const megabytes = (bytes: number) => `${Math.floor(bytes / MIB)} MB`;

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
  limits?: CallableFunctionDataLimits;
  now?: Date;
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
  if (pins.some(pin => pin.name === input.name)) {
    throw new ConflictError(`A data file named ${input.name} is already pinned.`, { code: 'data_name_taken' });
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

  const limits = deps.limits ?? (await resolveCallableFunctionDataLimits(actor));
  const pinnedBytes = pins.reduce((sum, pin) => sum + pin.bytes, 0);
  const checkSize = (bytes: number) => {
    if (bytes > limits.fileBytes) {
      throw new BadRequestError(`A data file can be at most ${megabytes(limits.fileBytes)}.`, {
        code: 'data_file_too_large',
        limit: limits.fileBytes,
      });
    }
    if (pinnedBytes + bytes > limits.totalBytes) {
      throw new BadRequestError(`A tool's data files can add up to at most ${megabytes(limits.totalBytes)}.`, {
        code: 'data_total_too_large',
        limit: limits.totalBytes,
      });
    }
  };
  // The recorded size first, so an oversize file is refused before any byte is read; then the bytes themselves.
  if (Number.isFinite(file.fileSize)) checkSize(file.fileSize);
  const bytes = await getFilesStorage().download(file.filePath);
  checkSize(bytes.length);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storage = deps.storage ?? getCallableFunctionDataStorage();
  const key = callableFunctionDataKey(fn.id, sha256);
  await storage.upload(bytes, key, { ContentType: 'application/octet-stream' });

  const pin: ICallableFunctionDataPin = {
    name: input.name,
    sha256,
    bytes: bytes.length,
    sourceFileId: file.id,
    pinnedAt: deps.now ?? new Date(),
  };
  const updated = await callableFunctionRepository.setDataPins(fn.id, userOwner(actor), fn, [...pins, pin]);
  if (!updated) {
    if (!pins.some(existing => existing.sha256 === sha256)) await storage.delete(key);
    throw changed();
  }
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
  if (!kept.some(pin => pin.sha256 === removed.sha256)) {
    await (deps.storage ?? getCallableFunctionDataStorage()).delete(callableFunctionDataKey(fn.id, removed.sha256));
  }
  return toCallableFunctionPublic(updated, await readHead(actor, fn.pin.artifactId));
}

/** The pinned bytes of one of the owner's functions, for the browser's `/data/<name>`. */
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
  return Promise.all(
    (fn.pin.dataPins ?? []).map(async ({ name, sha256, bytes }) => ({
      name,
      sha256,
      bytes,
      url: await storage.getSignedUrl(callableFunctionDataKey(fn.id, sha256), 'get', {
        expiresIn: CALLABLE_FUNCTION_DATA_LINK_SECONDS,
      }),
    }))
  );
}

/** Deletes every data object of one function. */
export async function deleteCallableFunctionDataObjects(
  functionId: string,
  storage: CallableFunctionDataStorage = getCallableFunctionDataStorage()
): Promise<number> {
  return storage.deletePrefix(callableFunctionDataPrefix(functionId));
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
