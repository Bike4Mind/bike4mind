import { currentPublishedIndexKey } from '@bike4mind/server-utils/services/publish/currentIndex';
import {
  SIGNED_LINK_TTL_SECONDS,
  isSafeSignedOrigin,
  signedResponseFor,
} from '@bike4mind/server-utils/services/publish/signedFiles';
import { NotFoundError, ServiceUnavailableError } from '@bike4mind/server-utils/utils/errors';
import type { getPublishedArtifactsStorage } from '@bike4mind/server-utils/utils/storage/index';

type BundleStorage = ReturnType<typeof getPublishedArtifactsStorage>;

interface BundlePage {
  storageKeyPrefix: string;
  indexObjectPath?: string | null;
}

export type BundleFileSigner = ((
  path: string,
  wantsDownload: boolean,
  ttlSeconds: number
) => Promise<string | null>) & {
  /** Origin of this deployment's signed links, '' when signing is unavailable or unsafe. */
  origin: () => Promise<string>;
};

/**
 * Signs bundle files for one request (see signedFiles.ts). Returns null instead of a URL
 * whenever the storage cannot sign for browsers (e.g. a server-only endpoint), its signing
 * origin is an app-controlled host, or a link lands anywhere but that one origin - callers
 * then fall back to the buffered path. The origin comes from the storage's own config, so
 * a CSP naming it admits exactly the bucket.
 */
export function makeBundleFileSigner(storage: BundleStorage, page: BundlePage, docOrigin: string): BundleFileSigner {
  let origin: Promise<string> | undefined;
  const originOnce = (): Promise<string> =>
    (origin ??= (async () => {
      if (typeof storage.browserSigningOrigin !== 'function') return '';
      try {
        const found = await storage.browserSigningOrigin();
        return found && isSafeSignedOrigin(found, docOrigin) ? found : '';
      } catch {
        return '';
      }
    })());
  const signer = (async (path: string, wantsDownload: boolean, ttlSeconds: number) => {
    const allowed = await originOnce();
    if (!allowed) return null;
    try {
      const key = path === 'index.html' ? currentPublishedIndexKey(page) : `${page.storageKeyPrefix}${path}`;
      const url = await storage.getSignedUrl(key, 'get', {
        audience: 'browser',
        expiresIn: ttlSeconds,
        ...signedResponseFor(path, wantsDownload),
      });
      return new URL(url).origin === allowed ? url : null;
    } catch {
      return null;
    }
  }) as BundleFileSigner;
  signer.origin = originOnce;
  return signer;
}

export interface ResolveBundleDownloadInput {
  storage: BundleStorage;
  artifact: BundlePage & { manifest: Array<{ path: string }> };
  /** Path of the file inside the bundle, as listed in the manifest. */
  assetPath: string;
  /** This deployment's own origin (see resolveDocOrigin); a signed link must not land on it. */
  docOrigin: string;
  ttlSeconds?: number;
}

export interface BundleDownload {
  /** Storage key of the object the link serves. */
  key: string;
  /** Always an attachment: publishers control MIME metadata, so a download never renders inline. */
  disposition: 'attachment';
  /** Short-lived signed URL; respond 3xx with it as the Location. */
  url: string;
}

/**
 * Decides which stored object a bundle download serves, with what disposition, and signs it.
 * Throws NotFoundError (`asset_not_found`) for a path outside the manifest and
 * ServiceUnavailableError (`download_unavailable`) when this storage cannot mint a browser link.
 */
export async function resolveBundleDownload({
  storage,
  artifact,
  assetPath,
  docOrigin,
  ttlSeconds = SIGNED_LINK_TTL_SECONDS,
}: ResolveBundleDownloadInput): Promise<BundleDownload> {
  if (!artifact.manifest.some(f => f.path === assetPath)) {
    throw new NotFoundError('Asset not in artifact manifest', { errorCode: 'asset_not_found' });
  }
  const url = await makeBundleFileSigner(storage, artifact, docOrigin)(assetPath, true, ttlSeconds);
  if (!url) {
    throw new ServiceUnavailableError('Downloads are unavailable for this artifact', {
      errorCode: 'download_unavailable',
    });
  }
  const key =
    assetPath === 'index.html' ? currentPublishedIndexKey(artifact) : `${artifact.storageKeyPrefix}${assetPath}`;
  return { key, disposition: 'attachment', url };
}
