import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { UpdateService, type UpdaterPort } from './UpdateService';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DismissedUpdatePreference } from './DismissedUpdatePreference';
import { releasePageUrl, resolveFeedUrl } from './feed';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createClient } from 'electron-updater/out/providerFactory';
import {
  manifestSignatureMessage,
  parseUpdatePublicKeys,
  decodeSignature,
  signatureFileName,
  verifyManifestSignature,
} from './manifestSignature';
import { SignedFeed, SignedFeedProvider } from './signedFeed';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { UpdateBusyReport, UpdateState } from '@shared/update';
import type { RequestOptions } from 'node:http';
import type { AppUpdater } from 'electron-updater';
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider';

const quitAndInstall = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall,
  },
}));

vi.mock('../windows', () => ({ appWindows: () => [] }));

describe('UpdateService', () => {
  const QUIET: UpdateBusyReport = { replying: 0, awaitingApproval: 0, background: 0 };

  function harness(options: { updater?: UpdaterPort | null; busy?: UpdateBusyReport } = {}) {
    const port: UpdaterPort = options.updater ?? {
      check: vi.fn(async () => undefined),
      download: vi.fn(async () => undefined),
      install: vi.fn(),
    };
    const busy = vi.fn(() => options.busy ?? QUIET);
    const prepareQuit = vi.fn(async () => undefined);
    const pushed: UpdateState[] = [];

    const service = new UpdateService({
      currentVersion: '1.0.0',
      updater: options.updater === null ? null : port,
      busy,
      prepareQuit,
      onChanged: state => pushed.push(state),
    });

    return { service, port, busy, prepareQuit, pushed };
  }

  /** Walk a service to 'ready', the way the updater's events would. */
  function stage(service: UpdateService): void {
    service.apply({ type: 'available', version: '1.1.0', at: 1 });
    service.apply({ type: 'downloaded', version: '1.1.0' });
  }

  describe('UpdateService without a feed', () => {
    it('stays unsupported and touches nothing', async () => {
      const { service, pushed } = harness({ updater: null });
      expect(service.snapshot().status).toBe('unsupported');

      await service.check();
      await service.download();
      expect(service.snapshot().status).toBe('unsupported');
      expect(pushed).toHaveLength(0);
    });

    it('refuses to install, since there is nothing to install', async () => {
      const { service } = harness({ updater: null });
      await expect(service.install(true)).resolves.toEqual({ ok: false, reason: 'not-ready' });
    });
  });

  describe('UpdateService.check', () => {
    it('reports the check started and asks the updater once', async () => {
      const { service, port, pushed } = harness();
      await service.check();
      expect(port.check).toHaveBeenCalledTimes(1);
      expect(pushed.map(state => state.status)).toEqual(['checking']);
    });

    it('turns a thrown check into a quiet unreachable, never a rejection', async () => {
      const { service } = harness({
        updater: {
          check: vi.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND');
          }),
          download: vi.fn(async () => undefined),
          install: vi.fn(),
        },
      });

      await expect(service.check()).resolves.toBeUndefined();
      expect(service.snapshot().status).toBe('unreachable');
    });

    it('does not re-check over a staged update', async () => {
      const { service, port } = harness();
      stage(service);
      await service.check();
      expect(port.check).not.toHaveBeenCalled();
      expect(service.snapshot().status).toBe('ready');
    });
  });

  describe('UpdateService.download', () => {
    it('only runs for an update that is actually on offer', async () => {
      const { service, port } = harness();
      await service.download();
      expect(port.download).not.toHaveBeenCalled();

      service.apply({ type: 'available', version: '1.1.0', at: 1 });
      await service.download();
      expect(port.download).toHaveBeenCalledTimes(1);
      expect(service.snapshot().status).toBe('downloading');
    });

    it('falls back to the offer when the download throws, so it can be retried', async () => {
      const { service } = harness({
        updater: {
          check: vi.fn(async () => undefined),
          download: vi.fn(async () => {
            throw new Error('socket hang up');
          }),
          install: vi.fn(),
        },
      });
      service.apply({ type: 'available', version: '1.1.0', at: 1 });
      await expect(service.download()).resolves.toBeUndefined();
      expect(service.snapshot()).toMatchObject({ status: 'available', version: '1.1.0', percent: 0 });
    });
  });

  describe('UpdateService.install', () => {
    let clock: ReturnType<typeof harness>;

    beforeEach(() => {
      clock = harness();
    });

    it('refuses before an update is staged', async () => {
      await expect(clock.service.install(false)).resolves.toEqual({ ok: false, reason: 'not-ready' });
      expect(clock.port.install).not.toHaveBeenCalled();
    });

    it('installs when nothing is running, killing children first', async () => {
      stage(clock.service);
      await expect(clock.service.install(false)).resolves.toEqual({ ok: true });
      expect(clock.prepareQuit).toHaveBeenCalledTimes(1);
      expect(clock.port.install).toHaveBeenCalledTimes(1);
    });

    it('reports what is in flight and does NOT quit', async () => {
      const busy = { replying: 1, awaitingApproval: 0, background: 2 };
      const { service, port, prepareQuit } = harness({ busy });
      stage(service);

      await expect(service.install(false)).resolves.toEqual({ ok: false, reason: 'busy', busy });
      expect(port.install).not.toHaveBeenCalled();
      expect(prepareQuit).not.toHaveBeenCalled();
      expect(service.snapshot().status).toBe('ready');
    });

    it('goes ahead once the user has forced it', async () => {
      const { service, port, prepareQuit } = harness({ busy: { replying: 1, awaitingApproval: 0, background: 0 } });
      stage(service);

      await expect(service.install(true)).resolves.toEqual({ ok: true });
      expect(prepareQuit).toHaveBeenCalledTimes(1);
      expect(port.install).toHaveBeenCalledTimes(1);
    });

    it('still hands over when the graceful teardown fails', async () => {
      const { service, port } = harness();
      stage(service);
      const failing = new UpdateService({
        currentVersion: '1.0.0',
        updater: { check: vi.fn(async () => undefined), download: vi.fn(async () => undefined), install: port.install },
        busy: () => QUIET,
        prepareQuit: async () => {
          throw new Error('a child would not die');
        },
        onChanged: () => undefined,
      });
      failing.apply({ type: 'available', version: '1.1.0', at: 1 });
      failing.apply({ type: 'downloaded', version: '1.1.0' });

      await expect(failing.install(true)).resolves.toEqual({ ok: true });
      expect(port.install).toHaveBeenCalledTimes(1);
    });
  });

  describe('UpdateService notice support', () => {
    function noticeHarness(memory: { stored?: string | null; failWrite?: boolean } = {}) {
      let stored = memory.stored ?? null;
      const dismissed = {
        read: vi.fn(async () => stored),
        record: vi.fn(async (version: string) => {
          if (memory.failWrite) throw new Error('EACCES');
          stored = version;
        }),
      };
      const log = vi.fn();
      const pushed: UpdateState[] = [];
      const service = new UpdateService({
        currentVersion: '1.0.0',
        updater: {
          check: vi.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND');
          }),
          download: vi.fn(async () => undefined),
          install: vi.fn(),
        },
        busy: () => QUIET,
        prepareQuit: async () => undefined,
        onChanged: state => pushed.push(state),
        releaseUrl: version => `https://example.test/releases/${version}`,
        dismissed,
        log,
      });
      return { service, dismissed, log, pushed, stored: () => stored };
    }

    it('attaches the release page for the offered version', () => {
      const { service } = noticeHarness();
      expect(service.snapshot().releaseUrl).toBeNull();
      service.apply({ type: 'available', version: '1.1.0', at: 1 });
      expect(service.snapshot().releaseUrl).toBe('https://example.test/releases/1.1.0');
    });

    it('persists a dismissal and pushes it to the renderer', async () => {
      const { service, pushed, stored } = noticeHarness();
      await service.dismiss('1.1.0');
      expect(stored()).toBe('1.1.0');
      expect(service.snapshot().dismissedVersion).toBe('1.1.0');
      expect(pushed.at(-1)?.dismissedVersion).toBe('1.1.0');
    });

    it('restores the dismissal from a previous launch', async () => {
      const { service, pushed } = noticeHarness({ stored: '1.1.0' });
      await service.restoreDismissed();
      expect(service.snapshot().dismissedVersion).toBe('1.1.0');
      expect(pushed).toHaveLength(1);
    });

    it('still hides the notice for this run when the file cannot be written, and logs it', async () => {
      const { service, log } = noticeHarness({ failWrite: true });
      await expect(service.dismiss('1.1.0')).resolves.toBeUndefined();
      expect(service.snapshot().dismissedVersion).toBe('1.1.0');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    });

    it('logs a failed check instead of surfacing it', async () => {
      const { service, log } = noticeHarness();
      await service.check();
      expect(service.snapshot().status).toBe('unreachable');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('ENOTFOUND'));
    });
  });
});

describe('DismissedUpdatePreference', () => {
  async function scratchFile(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'b4m-update-notice-')), 'nested', 'update-notice.json');
  }

  describe('DismissedUpdatePreference', () => {
    it('reads nothing before anything was dismissed', async () => {
      expect(await new DismissedUpdatePreference(await scratchFile()).read()).toBeNull();
    });

    it('round-trips the dismissed version, and a later dismissal replaces it', async () => {
      const path = await scratchFile();
      await new DismissedUpdatePreference(path).record('0.1.11');
      expect(await new DismissedUpdatePreference(path).read()).toBe('0.1.11');

      await new DismissedUpdatePreference(path).record('0.1.12');
      expect(await new DismissedUpdatePreference(path).read()).toBe('0.1.12');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ dismissedVersion: '0.1.12' });
    });

    it('treats a corrupt or wrongly shaped file as nothing dismissed', async () => {
      const path = join(await mkdtemp(join(tmpdir(), 'b4m-update-notice-')), 'update-notice.json');
      await writeFile(path, '{not json');
      expect(await new DismissedUpdatePreference(path).read()).toBeNull();
      await writeFile(path, JSON.stringify({ dismissedVersion: 7 }));
      expect(await new DismissedUpdatePreference(path).read()).toBeNull();
    });
  });
});

describe('feed', () => {
  describe('resolveFeedUrl', () => {
    it('treats nothing configured as "this build does not update"', () => {
      expect(resolveFeedUrl(undefined)).toBeNull();
      expect(resolveFeedUrl(null)).toBeNull();
      expect(resolveFeedUrl('')).toBeNull();
      expect(resolveFeedUrl('   ')).toBeNull();
    });

    it('accepts https and normalises it', () => {
      expect(resolveFeedUrl('https://example.test/releases')).toBe('https://example.test/releases');
      expect(resolveFeedUrl('  https://example.test/releases/  ')).toBe('https://example.test/releases/');
    });

    it('refuses plaintext from a real host, so nobody on the path picks the build', () => {
      expect(resolveFeedUrl('http://example.test/releases')).toBeNull();
    });

    it('allows plaintext on the loopback, which is how the check path is exercised locally', () => {
      expect(resolveFeedUrl('http://localhost:8080/releases')).toBe('http://localhost:8080/releases');
      expect(resolveFeedUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/');
    });

    it('refuses anything that is not a url, and any other scheme', () => {
      expect(resolveFeedUrl('not a url')).toBeNull();
      expect(resolveFeedUrl('/releases')).toBeNull();
      expect(resolveFeedUrl('file:///tmp/releases')).toBeNull();
      expect(resolveFeedUrl('javascript:alert(1)')).toBeNull();
    });
  });

  describe('releasePageUrl', () => {
    it("links a GitHub Releases feed to that version's tag page", () => {
      expect(releasePageUrl('https://github.com/acme/desktop-dist/releases/latest/download/', '0.1.11')).toBe(
        'https://github.com/acme/desktop-dist/releases/tag/desktop-v0.1.11'
      );
    });

    it('has no link for a feed whose layout it does not know', () => {
      expect(releasePageUrl(null, '0.1.11')).toBeNull();
      expect(releasePageUrl('https://updates.example.com/desktop/', '0.1.11')).toBeNull();
      expect(
        releasePageUrl('https://github.com/acme/desktop-dist/releases/download/desktop-v0.1.0/', '0.1.11')
      ).toBeNull();
      expect(releasePageUrl('not a url', '0.1.11')).toBeNull();
    });
  });
});

describe('signedFeed', () => {
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
  function connect(
    feed: SignedFeed,
    files: Record<string, string | null>,
    platform: ProviderRuntimeOptions['platform']
  ) {
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
      await expect(client.getLatestVersion()).rejects.toThrow(
        /^latest-linux\.yml\.sig could not be fetched: HTTP error/
      );
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
});

describe('manifestSignature', () => {
  const MANIFEST = Buffer.from('version: 0.2.3\nfiles:\n  - url: Bike4Mind-0.2.3-setup.exe\n    sha512: abc\n');

  function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { privateKey, encoded: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
  }

  function signatureFor(name: string, manifest: Uint8Array, privateKey: KeyObject): string {
    return `${sign(null, manifestSignatureMessage(name, manifest), privateKey).toString('base64')}\n`;
  }

  function trusted(...encoded: string[]): KeyObject[] {
    const parsed = parseUpdatePublicKeys(encoded.join(','));
    if (parsed.kind !== 'keys') throw new Error(`expected keys, got ${parsed.kind}`);
    return parsed.keys;
  }

  describe('parseUpdatePublicKeys', () => {
    it('treats an unset or blank value as no keys', () => {
      for (const raw of [undefined, null, '', '  \n']) {
        expect(parseUpdatePublicKeys(raw)).toEqual({ kind: 'none' });
      }
    });

    it('parses every comma-separated entry, tolerating whitespace around them', () => {
      const first = keyPair();
      const second = keyPair();
      const parsed = parseUpdatePublicKeys(` ${first.encoded} ,\n${second.encoded} `);
      expect(parsed.kind).toBe('keys');
      expect(parsed.kind === 'keys' && parsed.keys).toHaveLength(2);
    });

    it('rejects the whole value when any one entry is malformed', () => {
      const valid = keyPair().encoded;
      const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ format: 'der', type: 'spki' })
        .toString('base64');
      const x25519 = generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
      for (const bad of ['not-base64!', 'QUJDRA==', valid.slice(0, -4), rsa, x25519, '', `${valid}garbage`]) {
        const parsed = parseUpdatePublicKeys(`${valid},${bad}`);
        expect(parsed.kind, JSON.stringify(bad)).toBe('invalid');
        expect(parsed.kind === 'invalid' && parsed.reason).toBe(
          'B4M_UPDATE_PUBLIC_KEYS entry 2 is not a base64 Ed25519 SPKI public key'
        );
      }
    });
  });

  describe('verifyManifestSignature', () => {
    const signer = keyPair();
    const keys = trusted(signer.encoded);
    const signature = signatureFor('latest.yml', MANIFEST, signer.privateKey);

    it('accepts a signature made over this manifest and name by a listed key', () => {
      expect(verifyManifestSignature('latest.yml', MANIFEST, signature, keys)).toBe(true);
      expect(verifyManifestSignature('latest.yml', MANIFEST, signature.trimEnd(), keys)).toBe(true);
    });

    it('rejects a signature from a key that is not listed', () => {
      const other = keyPair();
      expect(verifyManifestSignature('latest.yml', MANIFEST, signature, trusted(other.encoded))).toBe(false);
    });

    it('rejects a manifest with any byte changed', () => {
      for (const index of [0, MANIFEST.length - 1]) {
        const tampered = Buffer.from(MANIFEST);
        tampered[index] ^= 1;
        expect(verifyManifestSignature('latest.yml', tampered, signature, keys)).toBe(false);
      }
      expect(verifyManifestSignature('latest.yml', Buffer.concat([MANIFEST, Buffer.from('\n')]), signature, keys)).toBe(
        false
      );
    });

    it('binds the manifest name, so one platform cannot stand in for another', () => {
      expect(verifyManifestSignature('latest-linux.yml', MANIFEST, signature, keys)).toBe(false);
      expect(verifyManifestSignature('latest-mac.yml', MANIFEST, signature, keys)).toBe(false);
    });

    it('rejects a missing or garbage signature', () => {
      for (const text of [null, '', '\n', 'garbage', 'QUJD\n', signature.replace(/[A-Z]/, '!')]) {
        expect(verifyManifestSignature('latest.yml', MANIFEST, text, keys)).toBe(false);
      }
    });

    it('verifies nothing against an empty key list', () => {
      expect(verifyManifestSignature('latest.yml', MANIFEST, signature, [])).toBe(false);
    });

    it('accepts a signature from any listed key, so a key can be rotated', () => {
      const next = keyPair();
      const both = trusted(signer.encoded, next.encoded);
      const fromNext = signatureFor('latest.yml', MANIFEST, next.privateKey);
      expect(verifyManifestSignature('latest.yml', MANIFEST, signature, both)).toBe(true);
      expect(verifyManifestSignature('latest.yml', MANIFEST, fromNext, both)).toBe(true);
      expect(verifyManifestSignature('latest.yml', MANIFEST, fromNext, keys)).toBe(false);
    });
  });

  describe('manifest framing', () => {
    it('frames the context, the name and the raw bytes', () => {
      expect(manifestSignatureMessage('latest-mac.yml', Buffer.from('a: 1\n')).toString()).toBe(
        'b4m-desktop-update-manifest-v1\nlatest-mac.yml\na: 1\n'
      );
      expect(signatureFileName('latest-linux-arm64.yml')).toBe('latest-linux-arm64.yml.sig');
    });

    it('refuses names that could blur the boundary between name and manifest', () => {
      for (const name of ['latest\n.yml', 'a/latest.yml', '../latest.yml', 'latest.yaml', '', '.yml']) {
        expect(() => manifestSignatureMessage(name, MANIFEST), JSON.stringify(name)).toThrow(/Not an update manifest/);
      }
    });

    it('decodes only a 64-byte base64 signature', () => {
      expect(decodeSignature(`${Buffer.alloc(64, 1).toString('base64')}\n`)).toHaveLength(64);
      expect(decodeSignature(Buffer.alloc(63, 1).toString('base64'))).toBeNull();
      expect(decodeSignature(Buffer.alloc(65, 1).toString('base64'))).toBeNull();
    });
  });
});

describe('signUpdateManifests', () => {
  const SCRIPT = fileURLToPath(new URL('../../../scripts/sign-update-manifests.mjs', import.meta.url));
  const MANIFESTS = ['latest-linux.yml', 'latest-mac.yml', 'latest.yml'];

  function keyPair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      encoded: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    };
  }

  function run(
    args: string[],
    env: Record<string, string>
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const child = execFile(
        process.execPath,
        [SCRIPT, ...args],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DESKTOP_UPDATE_SIGNING_KEY: '',
            DESKTOP_UPDATE_PUBLIC_KEYS: '',
            B4M_UPDATE_PUBLIC_KEYS: '',
            ...env,
          },
        },
        (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr })
      );
    });
  }

  describe('scripts/sign-update-manifests.mjs', () => {
    const signer = keyPair();
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'update-signing-'));
      for (const [index, name] of MANIFESTS.entries()) {
        await writeFile(join(dir, name), `version: 0.2.${index}\nfiles: []\n`);
      }
      await writeFile(join(dir, 'SHA256SUMS.txt'), 'abc  latest.yml\n');
      await writeFile(join(dir, 'install.sh'), '#!/bin/sh\n');
    });

    it('writes signatures the app verifies, and only for manifests', async () => {
      const result = await run(['sign', dir], {
        DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
        DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`Signed and verified: ${MANIFESTS.join(', ')}\n`);

      const keys = parseUpdatePublicKeys(signer.encoded);
      if (keys.kind !== 'keys') throw new Error('fixture key did not parse');
      expect((await readdir(dir)).filter(name => name.endsWith('.sig')).sort()).toEqual(
        MANIFESTS.map(name => `${name}.sig`)
      );
      for (const name of MANIFESTS) {
        const signature = await readFile(join(dir, `${name}.sig`), 'utf8');
        expect(signature).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
        expect(verifyManifestSignature(name, await readFile(join(dir, name)), signature, keys.keys)).toBe(true);
      }
      // Each signature is bound to its own manifest's name.
      const linuxSignature = await readFile(join(dir, 'latest-linux.yml.sig'), 'utf8');
      expect(
        verifyManifestSignature('latest.yml', await readFile(join(dir, 'latest-linux.yml')), linuxSignature, keys.keys)
      ).toBe(false);
    });

    it('fails without printing the key when the signing key is not one of the listed keys', async () => {
      const result = await run(['sign', dir], {
        DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
        DESKTOP_UPDATE_PUBLIC_KEYS: keyPair().encoded,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('latest-linux.yml.sig does not verify under any key in DESKTOP_UPDATE_PUBLIC_KEYS\n');
      expect(result.stdout + result.stderr).not.toContain('PRIVATE KEY');
    });

    it('fails on a missing or unusable signing key or key list', async () => {
      const ecdsa = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      });
      const cases: [Record<string, string>, string][] = [
        [{ DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded }, 'DESKTOP_UPDATE_SIGNING_KEY is empty'],
        [
          { DESKTOP_UPDATE_SIGNING_KEY: 'not a key', DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded },
          'DESKTOP_UPDATE_SIGNING_KEY is not a PEM private key',
        ],
        [
          { DESKTOP_UPDATE_SIGNING_KEY: ecdsa.toString(), DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded },
          'DESKTOP_UPDATE_SIGNING_KEY is not an Ed25519 key',
        ],
        [{ DESKTOP_UPDATE_SIGNING_KEY: signer.pem }, 'DESKTOP_UPDATE_PUBLIC_KEYS is empty'],
        [
          { DESKTOP_UPDATE_SIGNING_KEY: signer.pem, DESKTOP_UPDATE_PUBLIC_KEYS: `${signer.encoded},oops` },
          'DESKTOP_UPDATE_PUBLIC_KEYS entry 2 is not a base64 Ed25519 SPKI public key',
        ],
      ];
      const results = await Promise.all(cases.map(([env]) => run(['sign', dir], env)));
      for (const [index, [, message]] of cases.entries()) {
        expect(results[index].status, message).toBe(1);
        expect(results[index].stderr).toBe(`${message}\n`);
      }
    });

    it('fails when there is nothing to sign', async () => {
      const empty = await mkdtemp(join(tmpdir(), 'update-signing-empty-'));
      const result = await run(['sign', empty], {
        DESKTOP_UPDATE_SIGNING_KEY: signer.pem,
        DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/^No update manifests in /);
    });

    it('verify requires a valid signature for every manifest, under any listed key', async () => {
      const env = { DESKTOP_UPDATE_SIGNING_KEY: signer.pem, DESKTOP_UPDATE_PUBLIC_KEYS: signer.encoded };
      expect((await run(['sign', dir], env)).status).toBe(0);
      const previous = keyPair().encoded;
      expect((await run(['verify', dir], { DESKTOP_UPDATE_PUBLIC_KEYS: `${previous},${signer.encoded}` })).status).toBe(
        0
      );
      expect((await run(['verify', dir], { DESKTOP_UPDATE_PUBLIC_KEYS: previous })).status).toBe(1);

      await writeFile(join(dir, 'latest.yml'), 'version: 9.9.9\nfiles: []\n');
      expect((await run(['verify', dir], env)).stderr).toBe(
        'latest.yml.sig does not verify under any key in DESKTOP_UPDATE_PUBLIC_KEYS\n'
      );

      await rm(join(dir, 'latest-mac.yml.sig'));
      expect((await run(['verify', dir], env)).stderr).toBe('latest-mac.yml.sig is missing\n');
    });

    describe('check-build', () => {
      async function bundle(source: string): Promise<string> {
        const out = join(dir, 'out');
        await mkdir(join(out, 'main', 'chunks'), { recursive: true });
        await writeFile(join(out, 'main', 'index.js'), 'require("./chunks/update.js");\n');
        await writeFile(join(out, 'main', 'chunks', 'update.js'), source);
        return out;
      }

      it('passes when every configured key is baked into the main bundle', async () => {
        const other = keyPair().encoded;
        const keys = `${signer.encoded},${other}`;
        const out = await bundle(`const CONFIGURED_PUBLIC_KEYS = ${JSON.stringify(keys)};\n`);
        const result = await run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys });
        expect(result.stdout).toBe('The main bundle carries all 2 update key(s)\n');
        expect(result.status).toBe(0);
      });

      it('fails when a configured key is missing or still read at runtime', async () => {
        const keys = `${signer.encoded},${keyPair().encoded}`;
        let out = await bundle(`const CONFIGURED_PUBLIC_KEYS = ${JSON.stringify(signer.encoded)};\n`);
        expect((await run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys })).stderr).toBe(
          'B4M_UPDATE_PUBLIC_KEYS entry 2 is not in the main bundle\n'
        );

        out = await bundle('const CONFIGURED_PUBLIC_KEYS = process.env.B4M_UPDATE_PUBLIC_KEYS;\n');
        expect((await run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: keys })).stderr).toBe(
          'The main bundle still reads process.env.B4M_UPDATE_PUBLIC_KEYS at runtime\n'
        );

        expect((await run(['check-build', out], { B4M_UPDATE_PUBLIC_KEYS: 'not-a-key' })).status).toBe(1);
      });

      it('has nothing to check when no keys are configured', async () => {
        const out = await bundle('const CONFIGURED_PUBLIC_KEYS = "";\n');
        const result = await run(['check-build', out], {});
        expect(result.stdout).toBe('No update keys configured\n');
        expect(result.status).toBe(0);
      });
    });
  });
});

describe('registerUpdates install', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    quitAndInstall.mockClear();
  });

  it('installs silently and relaunches so Windows skips the setup wizard', async () => {
    vi.stubEnv('B4M_UPDATE_FEED_URL', 'https://example.com/releases/latest/download/');
    const { registerUpdates } = await import('./index');
    const { service, dispose } = registerUpdates({
      busy: () => ({ replying: 0, awaitingApproval: 0, background: 0 }),
      prepareQuit: async () => {},
    });
    service.apply({ type: 'downloaded', version: '9.9.9' });

    await service.install(true);
    dispose();

    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
