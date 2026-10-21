import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAppIdentity, DEV_APP_NAME } from './appIdentity';

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
    applyAppIdentity(host);
    expect(calls).toEqual({ name: DEV_APP_NAME, userData: join(APP_DATA, DEV_APP_NAME) });
  });

  // Renaming a packaged build would orphan every existing install's vault and keychain item.
  it('leaves a packaged build on its existing name and folder', () => {
    const { host, calls } = fakeHost(true);
    applyAppIdentity(host);
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
