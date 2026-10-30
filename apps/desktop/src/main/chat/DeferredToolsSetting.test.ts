import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredToolsSetting, parseDeferredToolsOverride, readServerValue } from './DeferredToolsSetting';

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
    expect(readServerValue([row('EnableDeferredToolLoading', true), row('DeferredToolStartSetMaxTokens', 0)])).toEqual({
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

  beforeEach(async () => {
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
      logger: { debug: vi.fn() },
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
