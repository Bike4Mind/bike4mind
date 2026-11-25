import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyAppIdentity, DEV_APP_NAME, DEV_USER_DATA_ENV } from './appIdentity';
import { EventEmitter } from 'node:events';
import { claimSingleInstance } from './singleInstance';

const APP_DATA = '/Users/someone/Library/Application Support';

function fakeHost(isPackaged: boolean) {
  const calls: { name?: string; userData?: string } = {};
  const host = {
    isPackaged,
    getPath: () => APP_DATA,
    setName: (name: string) => {
      calls.name = name;
    },
    setPath: (_name: 'userData', path: string) => {
      calls.userData = path;
    },
  };
  return { host, calls };
}

describe('applyAppIdentity', () => {
  it('moves a dev run onto its own name and userData folder', () => {
    const { host, calls } = fakeHost(false);
    applyAppIdentity(host, {});
    expect(calls).toEqual({ name: DEV_APP_NAME, userData: join(APP_DATA, DEV_APP_NAME) });
  });

  it('puts a dev run on an absolute userData override when one is given', () => {
    const { host, calls } = fakeHost(false);
    applyAppIdentity(host, { [DEV_USER_DATA_ENV]: '/tmp/b4m-throwaway' });
    expect(calls).toEqual({ name: DEV_APP_NAME, userData: '/tmp/b4m-throwaway' });
  });

  it('ignores a relative or blank override and keeps the shared dev folder', () => {
    for (const value of ['relative/dir', '   ']) {
      const { host, calls } = fakeHost(false);
      applyAppIdentity(host, { [DEV_USER_DATA_ENV]: value });
      expect(calls.userData).toBe(join(APP_DATA, DEV_APP_NAME));
    }
  });

  it('ignores the override in a packaged build', () => {
    const { host, calls } = fakeHost(true);
    applyAppIdentity(host, { [DEV_USER_DATA_ENV]: '/tmp/b4m-throwaway' });
    expect(calls).toEqual({});
  });

  // Renaming a packaged build would orphan every existing install's vault and keychain item.
  it('leaves a packaged build on its existing name and folder', () => {
    const { host, calls } = fakeHost(true);
    applyAppIdentity(host, {});
    expect(calls).toEqual({});
  });

  it('keeps the dev name distinct from the name packaged builds resolve to', async () => {
    const { default: manifest } = await import('../../package.json');
    expect(manifest).not.toHaveProperty('productName');
    expect(manifest.name).toBe('@bike4mind/desktop');
    expect(DEV_APP_NAME).not.toBe(manifest.name);
  });

  // A reorder (or an import sorter) would let another module resolve userData first.
  it('is the first import in the main entry point', () => {
    const source = readFileSync(join(__dirname, 'index.ts'), 'utf8');
    expect(source.match(/^import .*$/m)?.[0]).toBe("import './bootstrapIdentity';");
  });
});

describe('singleInstance', () => {
  function host(locked: boolean) {
    return Object.assign(new EventEmitter(), { requestSingleInstanceLock: vi.fn(() => locked) });
  }

  describe('claimSingleInstance', () => {
    it('holds the lock and brings the app forward on a second launch', () => {
      const app = host(true);
      const onSecondLaunch = vi.fn();
      expect(claimSingleInstance(app, onSecondLaunch)).toBe(true);

      app.emit('second-instance', {}, ['/Applications/Bike4Mind.app/Contents/MacOS/Bike4Mind'], '/');
      expect(onSecondLaunch).toHaveBeenCalledTimes(1);
    });

    it('reports a duplicate launch without listening for others', () => {
      const app = host(false);
      expect(claimSingleInstance(app, vi.fn())).toBe(false);
      expect(app.listenerCount('second-instance')).toBe(0);
    });
  });
});
