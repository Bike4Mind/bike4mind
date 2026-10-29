import { describe, expect, it, vi } from 'vitest';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';

const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';

function cipher(available = true) {
  return {
    isEncryptionAvailable: vi.fn(() => available),
    encryptString: vi.fn((plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`)),
    decryptString: vi.fn((encrypted: Buffer) => {
      const text = encrypted.toString();
      if (!text.startsWith('enc:')) throw new Error('bad blob');
      return Buffer.from(text.slice(4), 'hex').toString();
    }),
  };
}

function disk(initial: string | null = null) {
  const file = { contents: initial, read: vi.fn(async () => file.contents), write: vi.fn() };
  file.write.mockImplementation(async (next: string) => {
    file.contents = next;
  });
  return file;
}

const logger = () => ({ debug: vi.fn(), warn: vi.fn() });

describe('HuggingFaceTokenStore', () => {
  it('keeps the token when removing it fails to write', async () => {
    const file = disk();
    const store = new HuggingFaceTokenStore(cipher(), file, logger());
    await store.set(TOKEN);
    file.write.mockRejectedValueOnce(new Error('EACCES'));
    await expect(store.clear()).rejects.toThrow('EACCES');
    expect(await store.get()).toBe(TOKEN);
    expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBe(TOKEN);
  });

  it('keeps the token encrypted on disk and reads it back in a new run', async () => {
    const file = disk();
    await new HuggingFaceTokenStore(cipher(), file, logger()).set(TOKEN);
    expect(file.contents).not.toContain(TOKEN);
    expect(JSON.parse(file.contents ?? '{}')).toMatchObject({ version: 1, token: expect.any(String) });

    const next = new HuggingFaceTokenStore(cipher(), file, logger());
    expect(await next.get()).toBe(TOKEN);
    expect(next.persisted()).toBe(true);
  });

  it('without a keychain keeps the token for this run only and writes none of it', async () => {
    const file = disk();
    const store = new HuggingFaceTokenStore(cipher(false), file, logger());
    await store.set(TOKEN);
    expect(await store.get()).toBe(TOKEN);
    expect(store.persisted()).toBe(false);
    expect(file.contents).toBe('{"version":1}');

    expect(await new HuggingFaceTokenStore(cipher(false), file, logger()).get()).toBeNull();
  });

  it('removes the token from memory and disk', async () => {
    const file = disk();
    const store = new HuggingFaceTokenStore(cipher(), file, logger());
    await store.set(TOKEN);
    await store.clear();
    expect(await store.get()).toBeNull();
    expect(file.contents).toBe('{"version":1}');
    expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBeNull();
  });

  it('drops a blob it cannot decrypt without logging the blob', async () => {
    const file = disk(JSON.stringify({ version: 1, token: Buffer.from(TOKEN).toString('base64') }));
    const log = logger();
    expect(await new HuggingFaceTokenStore(cipher(), file, log).get()).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.warn.mock.calls, log.debug.mock.calls])).not.toContain(TOKEN);
  });

  it('reports unreadable files and retries the read without logging credentials', async () => {
    const missing = disk();
    missing.read.mockRejectedValueOnce(new Error('EACCES'));
    const log = logger();
    const store = new HuggingFaceTokenStore(cipher(), missing, log);
    await expect(store.get()).rejects.toThrow('Could not read');
    expect(log.warn).toHaveBeenCalledOnce();
    expect(await store.get()).toBeNull();
    expect(missing.read).toHaveBeenCalledTimes(2);
    expect(await new HuggingFaceTokenStore(cipher(), disk('{not json'), logger()).get()).toBeNull();
  });

  it('never persists a token with the Linux basic_text backend', async () => {
    const encryption = { ...cipher(), getSelectedStorageBackend: () => 'basic_text' };
    const file = disk();
    const store = new HuggingFaceTokenStore(encryption, file, logger());
    await store.set(TOKEN);
    expect(store.persisted()).toBe(false);
    expect(encryption.encryptString).not.toHaveBeenCalled();
    expect(file.contents).toBe('{"version":1}');
    expect(await store.get()).toBe(TOKEN);
    expect(await new HuggingFaceTokenStore(encryption, file, logger()).get()).toBeNull();
  });

  it('keeps the previous token when saving a replacement fails', async () => {
    const file = disk();
    const store = new HuggingFaceTokenStore(cipher(), file, logger());
    await store.set(TOKEN);
    file.write.mockRejectedValueOnce(new Error('EACCES'));
    await expect(store.set('hf_replacement')).rejects.toThrow('EACCES');
    expect(await store.get()).toBe(TOKEN);
    expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBe(TOKEN);
  });

  it('does not activate a token when encryption fails', async () => {
    const encryption = cipher();
    encryption.encryptString.mockImplementationOnce(() => { throw new Error('locked'); });
    const store = new HuggingFaceTokenStore(encryption, disk(), logger());
    await expect(store.set(TOKEN)).rejects.toThrow('locked');
    expect(await store.get()).toBeNull();
  });

});
