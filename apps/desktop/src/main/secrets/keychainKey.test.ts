import { describe, expect, it } from 'vitest';
import { fakeKeychain } from './fakeKeychain.testHelper';
import { loadSecretKey, secretKeyItem } from './keychainKey';
import type { ProcessRunner } from './runProcess';

const ITEM = secretKeyItem('Bike4Mind Dev');

describe('secretKeyItem', () => {
  it('names the item per app, beside safeStorage\'s own "<name> Safe Storage"', () => {
    expect(secretKeyItem('Bike4Mind')).toEqual({ service: 'Bike4Mind Secret Key', account: 'Bike4Mind' });
    expect(secretKeyItem('Bike4Mind Dev')).toEqual({ service: 'Bike4Mind Dev Secret Key', account: 'Bike4Mind Dev' });
  });
});

describe('loadSecretKey', () => {
  it('creates a 32-byte key once and reads the same one back afterwards', () => {
    const keychain = fakeKeychain();

    const first = loadSecretKey(ITEM, keychain.run, { create: true });
    const second = loadSecretKey(ITEM, keychain.run, { create: true });

    expect(first.state).toBe('found');
    expect(second.state).toBe('found');
    if (first.state !== 'found' || second.state !== 'found') return;
    expect(first.key).toHaveLength(32);
    expect(second.key.equals(first.key)).toBe(true);
    expect(keychain.calls.filter(call => call.args[0] === '-i')).toHaveLength(1);
  });

  it('runs /usr/bin/security by absolute path and passes the key on stdin, never in argv', () => {
    const keychain = fakeKeychain();

    const loaded = loadSecretKey(ITEM, keychain.run, { create: true });

    if (loaded.state !== 'found') throw new Error('expected a key');
    const encoded = loaded.key.toString('base64');
    expect(keychain.calls.every(call => call.file === '/usr/bin/security')).toBe(true);
    expect(keychain.calls.some(call => call.args.some(arg => arg.includes(encoded)))).toBe(false);
    const add = keychain.calls.find(call => call.args[0] === '-i');
    expect(add?.args).toEqual(['-i']);
    expect(add?.input).toBe(`add-generic-password -a "Bike4Mind Dev" -s "Bike4Mind Dev Secret Key" -w ${encoded}\n`);
  });

  it('reads with find-generic-password and creates only when the item does not exist (exit 44)', () => {
    const keychain = fakeKeychain();

    loadSecretKey(ITEM, keychain.run, { create: true });

    expect(keychain.calls.map(call => call.args[0])).toEqual(['find-generic-password', '-i', 'find-generic-password']);
    expect(keychain.calls[0].args).toEqual([
      'find-generic-password',
      '-a',
      'Bike4Mind Dev',
      '-s',
      'Bike4Mind Dev Secret Key',
      '-w',
    ]);
  });

  it('keeps the key another instance created first rather than replacing it', () => {
    const keychain = fakeKeychain();
    const theirs = Buffer.alloc(32, 7).toString('base64');
    let raced = false;
    const run: typeof keychain.run = (file, args, options) => {
      if (args[0] === '-i' && !raced) {
        raced = true;
        keychain.items.set(`${ITEM.service}|${ITEM.account}`, theirs);
      }
      return keychain.run(file, args, options);
    };

    const loaded = loadSecretKey(ITEM, run, { create: true });

    expect(loaded.state === 'found' && loaded.key.toString('base64')).toBe(theirs);
  });

  it('never creates when told only to read', () => {
    const keychain = fakeKeychain();

    expect(loadSecretKey(ITEM, keychain.run, { create: false })).toEqual({ state: 'missing' });
    expect(keychain.calls.some(call => call.args[0] === '-i')).toBe(false);
  });

  it('fails without creating when the read fails for any reason but a missing item', () => {
    for (const findStatus of [1, 51, 128]) {
      const keychain = fakeKeychain({ findStatus });
      expect(loadSecretKey(ITEM, keychain.run, { create: true }).state).toBe('failed');
      expect(keychain.calls.some(call => call.args[0] === '-i')).toBe(false);
    }
    const unstartable: ProcessRunner = () => ({ status: null, stdout: '', stderr: '' });
    expect(loadSecretKey(ITEM, unstartable, { create: true }).state).toBe('failed');
  });

  it('fails when the item cannot be created', () => {
    const keychain = fakeKeychain({ addStatus: 1 });

    expect(loadSecretKey(ITEM, keychain.run, { create: true })).toEqual({ state: 'missing' });
  });

  it('rejects a stored value that is not exactly 32 bytes of base64 and leaves it in place', () => {
    const keychain = fakeKeychain();
    keychain.items.set(`${ITEM.service}|${ITEM.account}`, Buffer.alloc(16, 1).toString('base64'));

    expect(loadSecretKey(ITEM, keychain.run, { create: true }).state).toBe('failed');
    expect(keychain.calls.some(call => call.args[0] === '-i')).toBe(false);
  });

  it('refuses to build an add command for a name the command line cannot quote', () => {
    for (const name of ['Odd "name"', 'back\\slash', 'line\nbreak', '']) {
      const keychain = fakeKeychain();

      expect(loadSecretKey(secretKeyItem(name), keychain.run, { create: true }).state).toBe('missing');
      expect(keychain.calls.some(call => call.args[0] === '-i')).toBe(false);
    }
  });
});
