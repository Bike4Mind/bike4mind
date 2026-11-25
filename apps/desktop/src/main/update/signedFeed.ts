import { createHash, type KeyObject } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AppUpdater, UpdateInfo } from 'electron-updater';
import { isUrlProbablySupportMultiRangeRequests } from 'electron-updater/out/providerFactory';
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider';
import { getFileList, parseUpdateInfo, type ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { getChannelFilename, newUrlFromBase } from 'electron-updater/out/util';
import { signatureFileName, verifyManifestSignature } from './manifestSignature';

/** electron-updater's `custom` provider route: `options` reaches the provider's constructor as-is. */
export interface SignedFeedOptions {
  provider: 'custom';
  updateProvider: typeof SignedFeedProvider;
  url: string;
  feed: SignedFeed;
}

interface VerifiedFile {
  /** Every name electron-updater may give this file in its download cache. */
  names: string[];
  sha512: string | null;
}

/**
 * Holds the trusted keys and the last manifest that verified under them.
 *
 * The provider hands it each manifest it fetches; only a manifest whose signature verifies is parsed
 * and returned to electron-updater. After a download, `confirmDownload` checks the file against that
 * same manifest before anything is told the update is ready.
 */
export class SignedFeed {
  private verified: { version: string; files: VerifiedFile[] } | null = null;

  constructor(private readonly keys: readonly KeyObject[]) {}

  publishOptions(url: string): SignedFeedOptions {
    return { provider: 'custom', updateProvider: SignedFeedProvider, url, feed: this };
  }

  /** Parses `raw` only when `signature` verifies over it; throws otherwise. */
  accept(manifestName: string, manifestUrl: URL, raw: string | null, signature: string | null): UpdateInfo {
    if (raw === null) throw new Error(`${manifestName} is empty`);
    if (signature === null) throw new Error(`${signatureFileName(manifestName)} is empty`);
    // electron-updater reads the body as UTF-8, so these are the published bytes for any valid manifest.
    if (!verifyManifestSignature(manifestName, Buffer.from(raw, 'utf8'), signature, this.keys)) {
      throw new Error(`${manifestName} does not verify under any configured update key`);
    }
    const info = parseUpdateInfo(raw, manifestName, manifestUrl);
    this.verified = {
      version: info.version,
      files: getFileList(info).map(file => ({
        names: cacheNames(file.url, manifestUrl),
        sha512: typeof file.sha512 === 'string' ? file.sha512 : null,
      })),
    };
    return info;
  }

  /**
   * Resolves to the verified version when `file` is a payload the verified manifest lists, by name and
   * SHA-512. Otherwise removes the file and rejects, which the caller reports as a failed download.
   */
  async confirmDownload(file: string | undefined): Promise<string> {
    if (!file) throw new Error('The updater reported no downloaded file');
    const verified = this.verified;
    if (!verified) throw new Error('No verified manifest to check the download against');

    const name = basename(file);
    const expected = verified.files.filter(entry => entry.names.includes(name)).map(entry => entry.sha512);
    if (expected.length > 0 && expected.includes(await sha512(file))) return verified.version;

    await unlink(file).catch(() => undefined);
    throw new Error(
      expected.length === 0
        ? `${name} is not listed in the verified manifest`
        : `${name} does not match the SHA-512 in the verified manifest`
    );
  }
}

/** Mirrors the two names AppUpdater.executeDownload gives a payload in its cache. */
function cacheNames(url: string, manifestUrl: URL): string[] {
  const names = [basename(url)];
  try {
    names.push(basename(decodeURIComponent(new URL(url, manifestUrl).pathname)));
  } catch {
    // An unparseable URL is one electron-updater cannot download either.
  }
  return names;
}

function sha512(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    createReadStream(file)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * A `generic` provider whose manifest lookup also fetches `<manifest>.sig` and verifies it before the
 * manifest is parsed. Everything else (file resolution, blockmaps, downloads) is GenericProvider's.
 */
export class SignedFeedProvider extends GenericProvider {
  private readonly signedFeed: SignedFeed;
  private readonly feedBase: URL;
  private readonly appUpdater: AppUpdater;

  constructor(options: SignedFeedOptions, updater: AppUpdater, runtimeOptions: ProviderRuntimeOptions) {
    // The same runtime options createClient gives a `generic` provider for this URL.
    super({ provider: 'generic', url: options.url }, updater, {
      ...runtimeOptions,
      isUseMultipleRangeRequest: isUrlProbablySupportMultiRangeRequests(options.url),
    });
    this.signedFeed = options.feed;
    this.appUpdater = updater;
    this.feedBase = new URL(options.url);
    if (!this.feedBase.pathname.endsWith('/')) this.feedBase.pathname += '/';
  }

  /** The channel file GenericProvider would request: latest.yml, latest-mac.yml, latest-linux[-arch].yml. */
  get manifestName(): string {
    const channel = this.appUpdater.channel;
    return getChannelFilename(channel ? this.getCustomChannelName(channel) : this.getDefaultChannelName());
  }

  override async getLatestVersion(): Promise<UpdateInfo> {
    const name = this.manifestName;
    const manifestUrl = newUrlFromBase(name, this.feedBase, true);
    const raw = await this.httpRequest(manifestUrl);
    let signature: string | null;
    try {
      signature = await this.httpRequest(newUrlFromBase(signatureFileName(name), this.feedBase, true));
    } catch (error) {
      const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
      throw new Error(`${signatureFileName(name)} could not be fetched: ${reason}`);
    }
    return this.signedFeed.accept(name, manifestUrl, raw, signature);
  }
}
