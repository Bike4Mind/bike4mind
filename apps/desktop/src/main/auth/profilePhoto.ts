import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AuthLogger } from '@bike4mind/client-auth';
import { MediaApiClient } from '../chat/media/MediaApiClient';
import { isSupportedMediaType, mediaUrl, type MediaStore } from '../chat/media/MediaStore';

/**
 * The media folder the signed-in user's picture lives in.
 *
 * MediaStore partitions by conversation id and SessionStore mints those with randomUUID, so a
 * fixed non-UUID name can never collide with a conversation's folder - and `forgetSession` on
 * this name is therefore safe to call on sign-out.
 */
export const PROFILE_PHOTO_BUCKET = 'profile-photo';

/** What the sidecar remembers about the file on disk. */
interface CacheRecord {
  key: string;
  name: string;
}

/** The sidecar file, injected so a test can hold it in memory. Mirrors auth's VaultFile. */
export interface PhotoRecordFile {
  read(): Promise<string | null>;
  write(contents: string): Promise<void>;
  remove(): Promise<void>;
}

/**
 * What a cached photo is keyed on.
 *
 * `source` is the account's raw `photoUrl`, which is an S3 key of the form
 * `profile-photos/<userId>/<uuid>.<ext>`: uploading a new picture mints a fresh uuid and
 * deletes the old object, so the key changes exactly when the picture does. The user id is
 * folded in as well, so a second account signing in on this machine can never match the
 * record the first one left - including for the legacy rows whose photoUrl is an absolute URL
 * carrying no user id of its own.
 */
export function profilePhotoCacheKey(userId: string, source: string): string {
  return `${userId}|${source}`;
}

/**
 * The backend's own file proxy, which serves bucket keys on deployments that front no CDN.
 *
 * Must stay in sync with `LOCAL_FILE_PROXY_BASE` in apps/client/server/utils/appFileProxy.ts,
 * the value an operator is expected to put in `NEXT_PUBLIC_CDN_URL` on such a stack.
 */
export const LOCAL_FILE_PROXY_BASE = '/api/app-files/serve';

/**
 * Where the bytes are actually downloaded from.
 *
 * `source` is a bucket key, and the deployment's CDN base is what turns one into a URL - the
 * same resolution `apps/client/app/utils/s3.ts` does for the web app. A `profile-photos/` key
 * needs no prefix rewrite (unlike `organizations/` or `admin/logos/`), so the base and the key
 * simply join. Hosted deployments advertise an absolute CDN. Self-host and personal dev stages
 * are *meant* to advertise the relative proxy above, but only do so when the operator set
 * `NEXT_PUBLIC_CDN_URL`; the caller supplies that fallback, so an empty base here means the
 * caller has no base at all. Returns null then, which is the "no photo" outcome, not an error.
 *
 * A source that is already absolute is returned untouched: some older rows hold a full URL.
 */
export function resolveProfilePhotoUrl(source: string, cdnUrl: string): string | null {
  if (/^https?:\/\//i.test(source)) return source;

  const base = cdnUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/${source.replace(/^\/+/, '')}`;
}

/**
 * The one profile picture on disk, plus the sidecar that says which account and which upload
 * it belongs to.
 *
 * The bytes go through MediaStore rather than anywhere of this module's own: the renderer runs
 * under a CSP that admits no remote origin, so a picture is only loadable once main has written
 * it into the media folder the `b4m-media:` handler serves. The sidecar is separate because
 * MediaStore names its files with a uuid, which is no use as a cache key on its own.
 */
export class ProfilePhotoCache {
  constructor(
    private readonly media: MediaStore,
    private readonly file: PhotoRecordFile
  ) {}

  /** The stored URL for this key, or null when nothing matching is on disk. */
  async lookup(key: string): Promise<string | null> {
    const record = await this.read();
    if (!record || record.key !== key) return null;
    // Confirm the bytes survived: userData can be cleared underneath us, and a url whose file
    // is gone renders as a broken image rather than falling back to initials.
    const stored = await this.media.read(PROFILE_PHOTO_BUCKET, record.name);
    return stored ? mediaUrl(PROFILE_PHOTO_BUCKET, record.name) : null;
  }

  /** Replace whatever is stored with these bytes. Returns the `b4m-media://` URL. */
  async store(key: string, bytes: Buffer, mimeType: string): Promise<string> {
    await this.media.forgetSession(PROFILE_PHOTO_BUCKET);
    const stored = await this.media.save(PROFILE_PHOTO_BUCKET, bytes, mimeType);
    await this.file.write(JSON.stringify({ key, name: stored.name } satisfies CacheRecord));
    return stored.url;
  }

  /** Drop the picture and the record of it. Called on sign-out. */
  async clear(): Promise<void> {
    await this.media.forgetSession(PROFILE_PHOTO_BUCKET);
    await this.file.remove();
  }

  private async read(): Promise<CacheRecord | null> {
    try {
      const contents = await this.file.read();
      if (!contents) return null;
      const parsed = JSON.parse(contents) as Partial<CacheRecord>;
      if (typeof parsed.key !== 'string' || typeof parsed.name !== 'string') return null;
      return { key: parsed.key, name: parsed.name };
    } catch {
      return null;
    }
  }
}

export interface ProfilePhotoRequest {
  api: AuthenticatedApiClient;
  cache: ProfilePhotoCache;
  logger: AuthLogger;
  userId: string;
  /** The account's raw `photoUrl` from the identity response. */
  source: string;
  /** `cdnUrl` from serverConfig; empty when the deployment advertises none. */
  cdnUrl: string;
  /**
   * Whether these bytes are still wanted, checked in the breath before they are written.
   * Sign-out invalidates synchronously, so a download that started before it can never land a
   * file after it - which is what keeps one account's face off disk once it has signed out.
   */
  isCurrent?: () => boolean;
}

/**
 * Get this account's picture onto disk and hand back the URL the renderer can load.
 *
 * Null on every failure, because the fallback is the initials the panel already draws and a
 * missing avatar is not worth telling anyone about. Downloading goes through MediaApiClient,
 * which is the app's existing b4m-file fetcher and already makes the call that matters here:
 * a relative URL is this backend's own proxy and carries the access token, an absolute one is
 * a public CDN and is fetched bare so the token never reaches an origin that is not the API.
 */
export async function fetchProfilePhoto(request: ProfilePhotoRequest): Promise<string | null> {
  const { api, cache, logger, userId, source, cdnUrl, isCurrent } = request;

  const key = profilePhotoCacheKey(userId, source);
  const cached = await cache.lookup(key);
  if (cached) return cached;

  const url = resolveProfilePhotoUrl(source, cdnUrl);
  if (!url) return null;

  try {
    const { bytes, contentType } = await new MediaApiClient(api).fetchGenerated(url);
    // Strict, and deliberately not falling back to the extension: an unauthenticated GET of a
    // protected path answers with a login page, and guessing `image/png` from the key would
    // write that HTML to disk as though it were a picture.
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    if (!mimeType.startsWith('image/') || !isSupportedMediaType(mimeType)) return null;
    if (isCurrent && !isCurrent()) return null;
    return await cache.store(key, bytes, mimeType);
  } catch (err) {
    logger.warn(`AUTH: profile photo unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}
