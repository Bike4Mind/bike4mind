import {
  BadGatewayError,
  BadRequestError,
  CALLABLE_FUNCTION_DATA_LIMITS,
  CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN,
  CALLABLE_FUNCTION_SOURCE_MODES,
  CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS,
  ConflictError,
  NotFoundError,
  resolvePythonArtifactDataOrigins,
  toCallableFunctionPublic,
  type CallableFunctionStampData,
  type ICallableFunctionDocument,
  type ICallableFunctionPublic,
  type ICallableFunctionSource,
  type ICallableFunctionSourcePin,
} from '@bike4mind/common';
import { adminSettingsRepository, artifactRepository, callableFunctionRepository } from '@bike4mind/database';
import { dataOriginReservedHosts } from '@bike4mind/services/llm/artifactGating';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { callableFunctionDataKey } from './dataKeys';
import {
  getCallableFunctionDataStorage,
  resolveCallableFunctionDataLimits,
  type CallableFunctionDataLimits,
  type CallableFunctionDataStorage,
} from './dataPins';
import {
  CALLABLE_FUNCTION_SOURCE_TIMEOUT_MS,
  CallableFunctionSourceError,
  selectCallableFunctionSourceFetcher,
  type CallableFunctionSourceFetcher,
} from './fetchSource';

/**
 * Data sources declared on a saved function: URLs on the admin-listed data origins (`pythonArtifactDataOrigins`),
 * fetched outside the sandbox and stored by hash under the function's prefix, so calls read them through the same
 * signed links as pinned files. A `live` source is fetched on every call; a `pinned` one at promotion.
 */

export interface CallableFunctionSourceDeps {
  fetcher?: CallableFunctionSourceFetcher;
  storage?: CallableFunctionDataStorage;
  /** The listed data origins; read from the setting when absent. */
  origins?: string[];
  limits?: CallableFunctionDataLimits;
  /** What a promotion in progress fetched; the record's frozen copies otherwise. */
  sourcePins?: ICallableFunctionSourcePin[];
}

/** The `pythonArtifactDataOrigins` setting, validated as every other reader validates it. */
export async function loadCallableFunctionSourceOrigins(): Promise<string[]> {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  return resolvePythonArtifactDataOrigins(
    getSettingsValue('pythonArtifactDataOrigins', settings),
    dataOriginReservedHosts()
  );
}

const userOwner = (actor: { id: string }) => ({ ownerType: 'user' as const, ownerKey: actor.id });
const notFound = () => new NotFoundError('Tool not found');

async function readHead(actor: { id: string }, artifactId: string) {
  const artifact = await artifactRepository.findOne({ id: artifactId, userId: actor.id });
  return artifact ? { version: artifact.version, deletedAt: artifact.deletedAt } : null;
}

const MODES: ReadonlySet<string> = new Set(CALLABLE_FUNCTION_SOURCE_MODES);

/** The url's origin when it is an https URL without user info, else null. */
function sourceOrigin(url: string): string | null {
  if (url.length > CALLABLE_FUNCTION_SOURCE_URL_MAX_CHARS || !/^https:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Replaces the function's sources and returns it to draft. Refuses an unsafe name, a name a data file or another
 * source holds, more sources than the data files leave room for, and a URL whose origin is not listed.
 */
export async function setCallableFunctionSources(
  actor: { id: string },
  functionId: string,
  sources: ICallableFunctionSource[],
  deps: CallableFunctionSourceDeps = {}
): Promise<ICallableFunctionPublic> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  const pins = fn.pin.dataPins ?? [];
  if (pins.length + sources.length > CALLABLE_FUNCTION_DATA_LIMITS.maxPins) {
    throw new ConflictError(
      `A tool can have at most ${CALLABLE_FUNCTION_DATA_LIMITS.maxPins} data files and sources together.`,
      { code: 'data_pin_limit', limit: CALLABLE_FUNCTION_DATA_LIMITS.maxPins }
    );
  }
  const taken = new Set(pins.map(pin => pin.name));
  let origins = deps.origins;
  const cleaned: ICallableFunctionSource[] = [];
  for (const { name, url, mode } of sources) {
    if (!CALLABLE_FUNCTION_DATA_PIN_NAME_PATTERN.test(name)) {
      throw new BadRequestError(
        'A source name is 1 to 64 letters, digits, ".", "_", or "-", starting with a letter or digit.',
        { code: 'data_name_invalid' }
      );
    }
    if (taken.has(name)) {
      throw new ConflictError(`A data file or source named ${name} already exists.`, { code: 'data_name_taken' });
    }
    taken.add(name);
    if (!MODES.has(mode)) throw new BadRequestError('A source is live or pinned.', { code: 'source_mode_invalid' });
    const origin = sourceOrigin(url);
    if (!origin) {
      throw new BadRequestError('A source URL is an https URL of at most 2048 characters.', {
        code: 'source_url_invalid',
      });
    }
    origins ??= await loadCallableFunctionSourceOrigins();
    if (!origins.includes(origin)) {
      throw new BadRequestError(`${origin} is not one of the data origins an administrator listed.`, {
        code: 'source_origin_unlisted',
        origin,
      });
    }
    cleaned.push({ name, url, mode });
  }
  const updated = await callableFunctionRepository.setSources(fn.id, userOwner(actor), fn, cleaned);
  if (!updated) {
    throw new ConflictError('The tool changed since you opened it. Reload it and try again.', {
      code: 'version_changed',
    });
  }
  return toCallableFunctionPublic(updated, await readHead(actor, fn.pin.artifactId));
}

type SourceOwner = Pick<ICallableFunctionDocument, 'id' | 'userId' | 'sources' | 'pin'>;

/** What one source resolved to for a call, and its bytes when they were fetched for it. */
export interface CallableFunctionSourceRead {
  entry: CallableFunctionStampData;
  body?: Buffer;
}

interface Resolved {
  fetcher: CallableFunctionSourceFetcher;
  storage: CallableFunctionDataStorage;
  origins: string[];
  limits: CallableFunctionDataLimits;
}

async function resolveDeps(fn: SourceOwner, deps: CallableFunctionSourceDeps): Promise<Resolved> {
  return {
    fetcher: deps.fetcher ?? selectCallableFunctionSourceFetcher(),
    storage: deps.storage ?? getCallableFunctionDataStorage(),
    origins: deps.origins ?? (await loadCallableFunctionSourceOrigins()),
    limits: deps.limits ?? (await resolveCallableFunctionDataLimits({ id: fn.userId })),
  };
}

/** Fetches through the guarded fetch, capped by the owner's per-file data limit, and stores the bytes by hash. */
async function fetchAndStore(fn: SourceOwner, source: ICallableFunctionSource, deps: Resolved) {
  const fetched = await deps.fetcher({
    url: source.url,
    origins: deps.origins,
    maxBodyBytes: deps.limits.fileBytes,
    timeoutMs: CALLABLE_FUNCTION_SOURCE_TIMEOUT_MS,
  });
  await deps.storage.upload(fetched.body, callableFunctionDataKey(fn.id, fetched.sha256), {
    ContentType: 'application/octet-stream',
  });
  return fetched;
}

/**
 * Each source as one call reads it: a `pinned` source promotion froze is read from its stored copy; every other
 * source is fetched now, stored, and stamped `live` with the time it was fetched. Throws `CallableFunctionSourceError`.
 */
export async function resolveCallableFunctionSources(
  fn: SourceOwner,
  deps: CallableFunctionSourceDeps = {},
  only?: string
): Promise<CallableFunctionSourceRead[]> {
  const sources = (fn.sources ?? []).filter(source => only === undefined || source.name === only);
  if (sources.length === 0) return [];
  const frozen = deps.sourcePins ?? fn.pin.sourcePins ?? [];
  const resolved = await resolveDeps(fn, deps);
  return Promise.all(
    sources.map(async (source): Promise<CallableFunctionSourceRead> => {
      const pin = source.mode === 'pinned' ? frozen.find(entry => entry.name === source.name) : undefined;
      if (pin) return { entry: { name: pin.name, mode: 'pinned', sha256: pin.sha256, bytes: pin.bytes } };
      const fetched = await fetchAndStore(fn, source, resolved);
      return {
        entry: {
          name: source.name,
          mode: 'live',
          sha256: fetched.sha256,
          bytes: fetched.bytes,
          fetched_at: fetched.fetchedAt,
        },
        body: fetched.body,
      };
    })
  );
}

/** Promotion's fetch of every `pinned` source, stored by hash; the result is what the promotion freezes. */
export async function fetchPinnedCallableFunctionSources(
  fn: SourceOwner,
  deps: CallableFunctionSourceDeps = {}
): Promise<ICallableFunctionSourcePin[]> {
  const pinned = (fn.sources ?? []).filter(source => source.mode === 'pinned');
  if (pinned.length === 0) return [];
  const resolved = await resolveDeps(fn, deps);
  return Promise.all(
    pinned.map(async source => {
      const fetched = await fetchAndStore(fn, source, resolved);
      return {
        name: source.name,
        sha256: fetched.sha256,
        bytes: fetched.bytes,
        fetchedAt: new Date(fetched.fetchedAt),
      };
    })
  );
}

/** One source's bytes and stamp entry for the owner's browser at `/data/<name>`, read as a call would read it. */
export async function readCallableFunctionSource(
  actor: { id: string },
  functionId: string,
  name: string,
  deps: CallableFunctionSourceDeps = {}
): Promise<{ entry: CallableFunctionStampData; bytes: Buffer }> {
  const fn = await callableFunctionRepository.findByIdForOwner(functionId, userOwner(actor));
  if (!fn) throw notFound();
  if (!fn.sources?.some(source => source.name === name)) throw new NotFoundError('Source not found');
  let read: CallableFunctionSourceRead | undefined;
  try {
    [read] = await resolveCallableFunctionSources(fn, deps, name);
  } catch (error) {
    if (error instanceof CallableFunctionSourceError) throw new BadGatewayError(error.message, { code: error.code });
    throw error;
  }
  if (!read) throw new NotFoundError('Source not found');
  const bytes =
    read.body ??
    (await (deps.storage ?? getCallableFunctionDataStorage()).download(
      callableFunctionDataKey(fn.id, read.entry.sha256)
    ));
  return { entry: read.entry, bytes };
}
