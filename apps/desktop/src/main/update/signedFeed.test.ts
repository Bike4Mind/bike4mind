import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { RequestOptions } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppUpdater } from 'electron-updater';
import { createClient } from 'electron-updater/out/providerFactory';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestSignatureMessage, parseUpdatePublicKeys } from './manifestSignature';
import { SignedFeed, SignedFeedProvider } from './signedFeed';

const FEED = 'https://github.com/example/dist/releases/latest/download/';
const RELEASE = 'https://github.com/example/dist/releases/download/desktop-v0.2.3/';
const PAYLOAD = Buffer.from('signed feed fixture, not an executable');
const IMAGE = 'Bike4Mind-0.2.3-x64.AppImage';

function manifest(file = IMAGE, payload = PAYLOAD): string {
  const sha512 = createHash('sha512').update(payload).digest('base64');
  return [
    'version: 0.2.3',
    'files:',
    `  - url: ${RELEASE}${file}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    `path: ${RELEASE}${file}`,
    `sha512: ${sha512}`,
    '',
  ].join('\n');
}

function signer() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const parsed = parseUpdatePublicKeys(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
  if (parsed.kind !== 'keys') throw new Error('fixture key did not parse');
  return { privateKey, keys: parsed.keys };
}

function signature(name: string, body: string, privateKey: KeyObject): string {
  return `${sign(null, manifestSignatureMessage(name, Buffer.from(body)), privateKey).toString('base64')}\n`;
}

/** A feed that answers by file name, standing in for electron-updater's HTTP executor. */
function connect(feed: SignedFeed, files: Record<string, string | null>, platform: ProviderRuntimeOptions['platform']) {
  const requested: string[] = [];
  const executor = {
    request: async (options: RequestOptions): Promise<string | null> => {
      const [path] = (options.path ?? '').split('?');
      requested.push(path);
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!(name in files)) throw Object.assign(new Error(`HTTP error: Not found\n${path}`), { statusCode: 404 });
      return files[name];
    },
  } as unknown as ProviderRuntimeOptions['executor'];
  const updater = { channel: null } as unknown as AppUpdater;
  const client = createClient(feed.publishOptions(FEED), updater, {
    platform,
    executor,
    isUseMultipleRangeRequest: true,
  });
  return { client, requested };
}

describe('SignedFeedProvider', () => {
  const { privateKey, keys } = signer();

  beforeEach(() => vi.stubEnv('TEST_UPDATER_ARCH', 'x64'));
  afterEach(() => vi.unstubAllEnvs());

  it('is what the custom provider route builds from the publish options', () => {
    const { client } = connect(new SignedFeed(keys), {}, 'linux');
    expect(client).toBeInstanceOf(SignedFeedProvider);
  });

  it('offers a manifest whose signature verifies, and resolves its files as GenericProvider does', async () => {
    const body = manifest();
    const { client, requested } = connect(
      new SignedFeed(keys),
      { 'latest-linux.yml': body, 'latest-linux.yml.sig': signature('latest-linux.yml', body, privateKey) },
      'linux'
    );

    const info = await client.getLatestVersion();

    expect(info.version).toBe('0.2.3');
    expect(requested).toEqual([
      '/example/dist/releases/latest/download/latest-linux.yml',
      '/example/dist/releases/latest/download/latest-linux.yml.sig',
    ]);
    expect(client.resolveFiles(info)[0].url.href).toBe(`${RELEASE}${IMAGE}`);
  });

  it.each([
    ['darwin', undefined, 'latest-mac.yml'],
    ['win32', undefined, 'latest.yml'],
    ['linux', 'arm64', 'latest-linux-arm64.yml'],
  ] as const)('binds the channel file electron-updater requests on %s %s', async (platform, arch, name) => {
    if (arch) vi.stubEnv('TEST_UPDATER_ARCH', arch);
    const body = manifest();
    const files = { [name]: body, [`${name}.sig`]: signature(name, body, privateKey) };
    const { client, requested } = connect(new SignedFeed(keys), files, platform);

    await expect(client.getLatestVersion()).resolves.toMatchObject({ version: '0.2.3' });
    expect(requested[0]).toBe(`/example/dist/releases/latest/download/${name}`);
  });

  it('refuses a manifest that has no signature', async () => {
    const { client } = connect(new SignedFeed(keys), { 'latest-linux.yml': manifest() }, 'linux');
    await expect(client.getLatestVersion()).rejects.toThrow(/^latest-linux\.yml\.sig could not be fetched: HTTP error/);
  });

  it('refuses an empty or garbage signature', async () => {
    for (const sig of [null, 'garbage\n']) {
      const { client } = connect(
        new SignedFeed(keys),
        { 'latest-linux.yml': manifest(), 'latest-linux.yml.sig': sig },
        'linux'
      );
      await expect(client.getLatestVersion()).rejects.toThrow(/latest-linux\.yml/);
    }
  });

  it('refuses a manifest changed after signing', async () => {
    const body = manifest();
    const { client } = connect(
      new SignedFeed(keys),
      {
        'latest-linux.yml': body.replace('0.2.3', '0.2.4'),
        'latest-linux.yml.sig': signature('latest-linux.yml', body, privateKey),
      },
      'linux'
    );
    await expect(client.getLatestVersion()).rejects.toThrow(
      'latest-linux.yml does not verify under any configured update key'
    );
  });

  it("refuses another platform's signed manifest served under this platform's name", async () => {
    const body = manifest('Bike4Mind-0.2.3-arm64.zip');
    const { client } = connect(
      new SignedFeed(keys),
      { 'latest-linux.yml': body, 'latest-linux.yml.sig': signature('latest-mac.yml', body, privateKey) },
      'linux'
    );
    await expect(client.getLatestVersion()).rejects.toThrow(/does not verify/);
  });

  it('refuses a signature from a key this build does not trust', async () => {
    const other = signer();
    const body = manifest();
    const { client } = connect(
      new SignedFeed(keys),
      { 'latest-linux.yml': body, 'latest-linux.yml.sig': signature('latest-linux.yml', body, other.privateKey) },
      'linux'
    );
    await expect(client.getLatestVersion()).rejects.toThrow(/does not verify/);
  });
});

describe('SignedFeed.confirmDownload', () => {
  const { privateKey, keys } = signer();
  let dir: string;

  beforeEach(async () => {
    vi.stubEnv('TEST_UPDATER_ARCH', 'x64');
    dir = await mkdtemp(join(tmpdir(), 'signed-feed-'));
  });
  afterEach(() => vi.unstubAllEnvs());

  async function verifiedFeed(): Promise<SignedFeed> {
    const feed = new SignedFeed(keys);
    const body = manifest();
    const { client } = connect(
      feed,
      { 'latest-linux.yml': body, 'latest-linux.yml.sig': signature('latest-linux.yml', body, privateKey) },
      'linux'
    );
    await client.getLatestVersion();
    return feed;
  }

  it('confirms a download whose name and SHA-512 match the verified manifest', async () => {
    const file = join(dir, IMAGE);
    await writeFile(file, PAYLOAD);
    await expect((await verifiedFeed()).confirmDownload(file)).resolves.toBe('0.2.3');
    expect(existsSync(file)).toBe(true);
  });

  it('rejects and removes a download whose bytes differ from the verified manifest', async () => {
    const file = join(dir, IMAGE);
    await writeFile(file, Buffer.from('different bytes'));
    await expect((await verifiedFeed()).confirmDownload(file)).rejects.toThrow(
      `${IMAGE} does not match the SHA-512 in the verified manifest`
    );
    expect(existsSync(file)).toBe(false);
  });

  it('rejects and removes a download the verified manifest does not list', async () => {
    const file = join(dir, 'Bike4Mind-0.2.3-setup.exe');
    await writeFile(file, PAYLOAD);
    await expect((await verifiedFeed()).confirmDownload(file)).rejects.toThrow(
      /is not listed in the verified manifest/
    );
    expect(existsSync(file)).toBe(false);
  });

  it('rejects before any manifest has verified, and when no file was reported', async () => {
    const file = join(dir, IMAGE);
    await writeFile(file, PAYLOAD);
    await expect(new SignedFeed(keys).confirmDownload(file)).rejects.toThrow(/No verified manifest/);
    await expect((await verifiedFeed()).confirmDownload(undefined)).rejects.toThrow(/no downloaded file/);
  });

  it('keeps checking against the last manifest that verified when a later one does not', async () => {
    const feed = await verifiedFeed();
    const { client } = connect(feed, { 'latest-linux.yml': manifest(IMAGE, Buffer.from('other')) }, 'linux');
    await expect(client.getLatestVersion()).rejects.toThrow();

    const file = join(dir, IMAGE);
    await writeFile(file, PAYLOAD);
    await expect(feed.confirmDownload(file)).resolves.toBe('0.2.3');
  });
});
