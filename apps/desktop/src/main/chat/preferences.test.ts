// The small file-backed preferences, one describe per module, kept in one file because every test file pays its own import and setup.
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ModelPreference } from './ModelPreference';
import { LocalContextPreference } from './LocalContextPreference';
import { SpawnLocationPreference } from './SpawnLocationPreference';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { DeferredToolsSetting, parseDeferredToolsOverride, readServerValue } from './DeferredToolsSetting';

describe('ModelPreference', () => {
  async function preferenceFile(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'b4m-model-pref-')), 'model-preference.json');
  }

  describe('ModelPreference', () => {
    it('remembers nothing until the user picks', async () => {
      expect(await new ModelPreference(await preferenceFile()).read()).toBeNull();
    });

    it('survives a restart', async () => {
      const file = await preferenceFile();
      await new ModelPreference(file).record('gpt-5.5');

      expect(await new ModelPreference(file).read()).toBe('gpt-5.5');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ model: 'gpt-5.5' });
    });

    it('answers from memory after the first read, so a new conversation never waits on the disk', async () => {
      const file = await preferenceFile();
      const preference = new ModelPreference(file);
      await preference.record('gpt-5.5');
      await writeFile(file, JSON.stringify({ model: 'changed-underneath' }), 'utf8');

      expect(await preference.read()).toBe('gpt-5.5');
    });

    it('treats an unreadable or malformed file as no pick', async () => {
      const file = await preferenceFile();
      await writeFile(file, '{not json', 'utf8');
      expect(await new ModelPreference(file).read()).toBeNull();

      await writeFile(file, JSON.stringify({ model: 42 }), 'utf8');
      expect(await new ModelPreference(file).read()).toBeNull();
    });

    it('ignores a blank pick rather than forgetting the last real one', async () => {
      const file = await preferenceFile();
      const preference = new ModelPreference(file);
      await preference.record('gpt-5.5');
      await preference.record('  ');

      expect(await new ModelPreference(file).read()).toBe('gpt-5.5');
    });
  });
});

describe('LocalContextPreference', () => {
  async function preferenceFile(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'b4m-local-context-')), 'local-context.json');
  }

  describe('LocalContextPreference', () => {
    it('is Auto until the user picks a size', async () => {
      expect(await new LocalContextPreference(await preferenceFile()).read()).toEqual({ mode: 'auto' });
    });

    it('survives a restart', async () => {
      const file = await preferenceFile();
      expect(await new LocalContextPreference(file).record({ mode: 'fixed', tokens: 32768 })).toEqual({
        mode: 'fixed',
        tokens: 32768,
      });

      expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'fixed', tokens: 32768 });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'fixed', tokens: 32768 });
    });

    it('saves two quick changes without one tripping over the other', async () => {
      const file = await preferenceFile();
      const preference = new LocalContextPreference(file);
      await expect(
        Promise.all([preference.record({ mode: 'fixed', tokens: 32768 }), preference.record({ mode: 'auto' })])
      ).resolves.toEqual([{ mode: 'fixed', tokens: 32768 }, { mode: 'auto' }]);
      expect([{ mode: 'auto' }, { mode: 'fixed', tokens: 32768 }]).toContainEqual(
        JSON.parse(await readFile(file, 'utf8'))
      );
    });

    it('stores Auto for a size Settings does not offer', async () => {
      const file = await preferenceFile();
      expect(await new LocalContextPreference(file).record({ mode: 'fixed', tokens: 1000 })).toEqual({ mode: 'auto' });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ mode: 'auto' });
    });

    it('reads an unreadable or malformed file as Auto', async () => {
      const file = await preferenceFile();
      await writeFile(file, '{not json', 'utf8');
      expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'auto' });

      await writeFile(file, JSON.stringify({ mode: 'fixed', tokens: '32768' }), 'utf8');
      expect(await new LocalContextPreference(file).read()).toEqual({ mode: 'auto' });
    });
  });
});

describe('SpawnLocationPreference', () => {
  async function preferenceFile(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'b4m-spawn-location-')), 'spawn-location.json');
  }

  describe('SpawnLocationPreference', () => {
    it('is a new worktree until the user picks otherwise', async () => {
      expect(await new SpawnLocationPreference(await preferenceFile()).read()).toBe('worktree');
    });

    it('survives a restart', async () => {
      const file = await preferenceFile();
      expect(await new SpawnLocationPreference(file).record('ask')).toBe('ask');

      expect(await new SpawnLocationPreference(file).read()).toBe('ask');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'ask' });
    });

    it('saves two quick changes in order', async () => {
      const file = await preferenceFile();
      const preference = new SpawnLocationPreference(file);
      await expect(Promise.all([preference.record('local'), preference.record('ask')])).resolves.toEqual([
        'local',
        'ask',
      ]);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'ask' });
      expect(await preference.read()).toBe('ask');
    });

    it('stores the default for a value Settings does not offer', async () => {
      const file = await preferenceFile();
      expect(await new SpawnLocationPreference(file).record('here')).toBe('worktree');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ location: 'worktree' });
    });

    it('reads an unreadable or malformed file as the default', async () => {
      const file = await preferenceFile();
      await writeFile(file, '{not json', 'utf8');
      expect(await new SpawnLocationPreference(file).read()).toBe('worktree');

      await writeFile(file, JSON.stringify({ location: 42 }), 'utf8');
      expect(await new SpawnLocationPreference(file).read()).toBe('worktree');
    });
  });
});

describe('DeferredToolsSetting', () => {
  const row = (settingName: string, settingValue: unknown) => ({ settingName, settingValue });

  describe('parseDeferredToolsOverride', () => {
    it('forces deferral off for 0 and on for 1, and follows the server otherwise', () => {
      expect(parseDeferredToolsOverride(' 0 ', undefined)).toEqual({ enabled: false });
      expect(parseDeferredToolsOverride('1', undefined)).toEqual({ enabled: true });
      expect(parseDeferredToolsOverride(undefined, undefined)).toEqual({});
      expect(parseDeferredToolsOverride('yes', '')).toEqual({});
    });

    it('takes a non-negative start-set limit and ignores anything else', () => {
      expect(parseDeferredToolsOverride(undefined, '0')).toEqual({ startSetMaxTokens: 0 });
      expect(parseDeferredToolsOverride(undefined, ' 5000 ')).toEqual({ startSetMaxTokens: 5000 });
      expect(parseDeferredToolsOverride(undefined, '-1')).toEqual({});
      expect(parseDeferredToolsOverride(undefined, 'lots')).toEqual({});
    });
  });

  describe('readServerValue', () => {
    it('reads the stored rows, in their string storage form too', () => {
      expect(
        readServerValue([row('EnableDeferredToolLoading', true), row('DeferredToolStartSetMaxTokens', 0)])
      ).toEqual({
        enabled: true,
        startSetMaxTokens: 0,
      });
      expect(
        readServerValue([row('EnableDeferredToolLoading', 'true'), row('DeferredToolStartSetMaxTokens', '500')])
      ).toEqual({ enabled: true, startSetMaxTokens: 500 });
    });

    it('reads a missing row as the default, which is off', () => {
      expect(readServerValue([row('enforceCredits', true)])).toEqual({ enabled: false, startSetMaxTokens: 100_000 });
    });

    it('has no answer for a body that is not the rows', () => {
      expect(readServerValue({ error: 'nope' })).toBeUndefined();
      expect(readServerValue(undefined)).toBeUndefined();
    });
  });

  describe('DeferredToolsSetting', () => {
    let filePath: string;
    let environmentUrl: string;
    let now: number;
    let get: ReturnType<typeof vi.fn>;
    let signedIn: boolean;
    let debug: Mock<(message: string) => void>;

    beforeEach(async () => {
      debug = vi.fn();
      filePath = join(await mkdtemp(join(tmpdir(), 'b4m-deferred-setting-')), 'deferred-tools.json');
      environmentUrl = 'https://one.example';
      now = 1_000;
      signedIn = true;
      get = vi.fn().mockResolvedValue([row('EnableDeferredToolLoading', true)]);
    });

    const setting = (override?: { enabled?: boolean; startSetMaxTokens?: number }) =>
      new DeferredToolsSetting({
        filePath,
        getApiClient: () => (signedIn ? ({ get } as unknown as AuthenticatedApiClient) : null),
        getEnvironmentUrl: () => environmentUrl,
        logger: { debug },
        override,
        now: () => now,
      });

    it('is off until the server says on, then on with its start-set limit', async () => {
      get.mockResolvedValue([row('EnableDeferredToolLoading', true), row('DeferredToolStartSetMaxTokens', 2000)]);
      const subject = setting();
      expect(subject.current()).toBeUndefined();
      await subject.refresh();
      expect(subject.current()).toEqual({ startSetMaxTokens: 2000 });
      expect(get).toHaveBeenCalledWith('/api/settings/fetch');
    });

    it('turns off when the server turns it off, from the next answer on', async () => {
      const subject = setting();
      await subject.refresh();
      expect(subject.current()).toEqual({ startSetMaxTokens: 100_000 });

      get.mockResolvedValue([row('EnableDeferredToolLoading', false)]);
      now += 60_000;
      expect(subject.current()).toBeDefined();
      now += 10 * 60_000;
      subject.current();
      await subject.refresh();
      expect(subject.current()).toBeUndefined();
    });

    it('keeps the last known answer across launches when the server cannot be asked', async () => {
      await setting().refresh();
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        [environmentUrl]: { enabled: true, startSetMaxTokens: 100_000 },
      });

      get.mockRejectedValue(new Error('offline'));
      const offline = setting();
      await offline.refresh();
      expect(offline.current()).toEqual({ startSetMaxTokens: 100_000 });

      signedIn = false;
      const signedOut = setting();
      await signedOut.refresh();
      expect(signedOut.current()).toEqual({ startSetMaxTokens: 100_000 });
    });

    it('is off when the server cannot be asked and nothing is known', async () => {
      get.mockRejectedValue(new Error('offline'));
      const subject = setting();
      await subject.refresh();
      expect(subject.current()).toBeUndefined();

      await writeFile(filePath, 'not json', 'utf8');
      const corrupt = setting();
      await corrupt.refresh();
      expect(corrupt.current()).toBeUndefined();
    });

    it('logs an answer that is not the settings rows and keeps the last known value', async () => {
      const subject = setting();
      await subject.refresh();
      expect(debug).not.toHaveBeenCalled();

      get.mockResolvedValue({ error: 'nope' });
      now += 10 * 60_000;
      await subject.refresh();
      expect(subject.current()).toEqual({ startSetMaxTokens: 100_000 });
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('returned object rather than the settings rows'));
    });

    it('keeps one answer per server', async () => {
      const subject = setting();
      await subject.refresh();
      environmentUrl = 'http://localhost:3000';
      get.mockRejectedValue(new Error('offline'));
      expect(subject.current()).toBeUndefined();
      await subject.refresh();
      expect(subject.current()).toBeUndefined();
      environmentUrl = 'https://one.example';
      expect(subject.current()).toEqual({ startSetMaxTokens: 100_000 });
    });

    it('lets the local override win without asking the server', async () => {
      get.mockResolvedValue([row('EnableDeferredToolLoading', false)]);
      const forcedOn = setting({ enabled: true, startSetMaxTokens: 0 });
      expect(forcedOn.current()).toEqual({ startSetMaxTokens: 0 });
      expect(get).not.toHaveBeenCalled();

      get.mockResolvedValue([row('EnableDeferredToolLoading', true)]);
      const forcedOff = setting({ enabled: false });
      await forcedOff.refresh();
      expect(forcedOff.current()).toBeUndefined();

      const limited = setting({ startSetMaxTokens: 10 });
      await limited.refresh();
      expect(limited.current()).toEqual({ startSetMaxTokens: 10 });
    });
  });
});
