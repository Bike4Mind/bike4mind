import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { CommandHistoryStore, MAX_ENTRY_BYTES, MAX_HISTORY_ENTRIES, isSafeHistoryEntry } from './CommandHistoryStore';

let dir: string;
let file: string;

const line = (command: string, timestamp = 1) => JSON.stringify({ command, timestamp }) + '\n';

async function fileLines(): Promise<string[]> {
  return (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
}

async function freshLoad(): Promise<string[]> {
  return new CommandHistoryStore(file, { persist: true }).load();
}

async function writeHistory(content: string, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  await fs.chmod(file, mode);
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => line(`cmd ${i}`, i)).join('');

const tmpFiles = async () => (await fs.readdir(path.dirname(file))).filter(name => !name.endsWith('history.jsonl'));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-history-'));
  file = path.join(dir, 'nested', 'history.jsonl');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(path.dirname(file), 0o700).catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});

describe('CommandHistoryStore', () => {
  it('starts empty when the file is missing and creates it 0600 on the first entry', async () => {
    const store = new CommandHistoryStore(file, { persist: true });
    expect(await store.load()).toEqual([]);

    expect(store.add('first')).toEqual(['first']);
    await store.whenIdle();

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await freshLoad()).toEqual(['first']);
    expect(await tmpFiles()).toEqual([]);
  });

  it('tightens an existing file to 0600 as soon as it is read', async () => {
    await writeHistory(line('old'), 0o664);

    await freshLoad();

    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('returns entries newest first across restarts', async () => {
    const first = new CommandHistoryStore(file, { persist: true });
    await first.load();
    first.add('one');
    first.add('/help');
    first.add('three');
    await first.whenIdle();

    expect(await freshLoad()).toEqual(['three', '/help', 'one']);
  });

  it('round-trips multi-line entries as one JSON line each', async () => {
    const store = new CommandHistoryStore(file, { persist: true });
    await store.load();
    store.add('line one\nline two\n  indented "quoted" \\ back');
    await store.whenIdle();

    expect(await fileLines()).toHaveLength(1);
    expect(await freshLoad()).toEqual(['line one\nline two\n  indented "quoted" \\ back']);
  });

  it('skips empty input and keeps only the newest copy of each command', async () => {
    const store = new CommandHistoryStore(file, { persist: true });
    await store.load();
    for (const entry of ['a', '   ', '', 'a', ' a ', 'b', 'c', 'a']) store.add(entry);
    await store.whenIdle();

    expect(await store.load()).toEqual(['a', 'c', 'b']);
    expect(await fileLines()).toHaveLength(4);
    expect(await freshLoad()).toEqual(['a', 'c', 'b']);
  });

  it('caps recall at the newest entries and compacts an oversized file', async () => {
    const total = MAX_HISTORY_ENTRIES + 150;
    await writeHistory(numbered(total));

    const loaded = await freshLoad();

    expect(loaded).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(loaded[0]).toBe(`cmd ${total - 1}`);
    expect(loaded[loaded.length - 1]).toBe(`cmd ${total - MAX_HISTORY_ENTRIES}`);
    const lines = await fileLines();
    expect(lines).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(JSON.parse(lines[0])).toEqual({ command: `cmd ${total - MAX_HISTORY_ENTRIES}`, timestamp: 150 });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await tmpFiles()).toEqual([]);
  });

  it('only appends while the file is within the compaction slack and every line is valid', async () => {
    const total = MAX_HISTORY_ENTRIES + 20;
    await writeHistory(numbered(total));

    expect(await freshLoad()).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(await fileLines()).toHaveLength(total);
  });

  it('keeps the in-memory list capped during a long session', async () => {
    const store = new CommandHistoryStore(file, { persist: false, maxEntries: 3 });
    for (const entry of ['1', '2', '3', '4']) store.add(entry);
    expect(store.add('5')).toEqual(['5', '4', '3']);
  });

  it('drops malformed lines on load and rewrites the file without them', async () => {
    await writeHistory(
      ['not json', line('good one').trim(), '{"command": 42}', '[1,2]', 'null', '{"comm', line('good two').trim()].join(
        '\n'
      ) + '\n'
    );

    expect(await freshLoad()).toEqual(['good two', 'good one']);
    expect(await fileLines()).toEqual([line('good one').trim(), line('good two').trim()]);
  });

  it('compacts a file holding invalid UTF-8 instead of wedging on a size mismatch', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.concat([Buffer.from(line('kept')), Buffer.from([0xff, 0xfe, 0x0a])]));

    expect(await freshLoad()).toEqual(['kept']);
    expect(await fileLines()).toEqual([line('kept').trim()]);
  });

  it('starts empty instead of throwing when the file cannot be read', async () => {
    await fs.mkdir(file, { recursive: true });
    const store = new CommandHistoryStore(file, { persist: true });
    expect(await store.load()).toEqual([]);
    expect(store.add('still works in memory')).toEqual(['still works in memory']);
    await expect(store.whenIdle()).resolves.toBeUndefined();
  });

  it('keeps working when the folder is not writable', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.chmod(path.dirname(file), 0o500);
    const store = new CommandHistoryStore(file, { persist: true });
    await store.load();
    store.add('entry');
    await expect(store.whenIdle()).resolves.toBeUndefined();
  });

  it('does not glue the next entry onto a torn last line', async () => {
    await writeHistory(line('kept') + '{"command":"torn');
    const store = new CommandHistoryStore(file, { persist: true });
    expect(await store.load()).toEqual(['kept']);

    store.add('after');
    await store.whenIdle();

    expect(await freshLoad()).toEqual(['after', 'kept']);
  });

  it('puts entries added before the file finished loading ahead of the stored ones', async () => {
    await writeHistory(line('stored'));
    const store = new CommandHistoryStore(file, { persist: true });

    const loading = store.load();
    store.add('early');

    expect(await loading).toEqual(['early', 'stored']);
    await store.whenIdle();
    expect(await freshLoad()).toEqual(['early', 'stored']);
  });

  it('never writes input that may carry a secret, but keeps it recallable for the session', async () => {
    const secrets = [
      '!export OPENAI_API_KEY=abc123',
      '!GITHUB_TOKEN=ghp_abcdefghijklmnop gh pr list',
      'my password = hunter22',
      '{"password": "hunter22"}',
      "db:\n  password: 'hunter22'",
      'api_key: abc123',
      '!mytool --api-key abc123',
      '!mytool --token=abc123',
      '!deploy --db-password hunter22',
      '/set-api https://admin:hunter2@self-hosted.example.com',
      "!curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.com",
      "!curl -H 'x-api-key: abc123' https://example.com",
      '!curl -u admin:hunter22 https://example.com',
      '!curl --user=admin:hunter22 https://example.com',
      '!mysql -u root -phunter22 app',
      '!docker login -u me -p hunter22 registry.example.com',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
      'decode eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl',
      'use b4m_live_abcdefghijklmnop for the call',
      'the key is sk-abcdefghijklmnopqrstuvwxyz',
      'stripe sk_live_abcdefghijklmnop and rk_live_abcdefghijklmnop',
      'hf_abcdefghijklmnopqrstuvwxyz',
      'npm_abcdefghijklmnopqrstuvwxyz',
      'AIzaSyabcdefghijklmnopqrstuvwxyz',
      'xapp-1-abcdefghijklmnop',
      'AKIAABCDEFGHIJKLMNOP',
    ];
    const safe = [
      '/set-api https://self-hosted.example.com',
      'how do tokens work?',
      '!ls -la',
      '/login',
      'explain the task-12345678 failure',
      '!mysql -u root -p app',
      '!curl https://example.com/path:8080',
      '!docker login registry.example.com',
    ];

    const store = new CommandHistoryStore(file, { persist: true });
    await store.load();
    for (const entry of [...secrets, ...safe]) store.add(entry);
    await store.whenIdle();

    for (const entry of secrets) expect(isSafeHistoryEntry(entry), entry).toBe(false);
    for (const entry of safe) expect(isSafeHistoryEntry(entry), entry).toBe(true);
    expect(await store.load()).toEqual([...secrets, ...safe].reverse());
    const contents = await fs.readFile(file, 'utf-8');
    for (const secret of secrets) expect(contents).not.toContain(JSON.stringify(secret).slice(1, -1));
    expect(await freshLoad()).toEqual([...safe].reverse());
  });

  it('drops secret lines a previous version wrote and rewrites the file without them', async () => {
    await writeHistory(line('safe one') + line('!export AWS_SECRET_ACCESS_KEY=abc') + line('safe two'), 0o664);

    expect(await freshLoad()).toEqual(['safe two', 'safe one']);
    expect(await fs.readFile(file, 'utf-8')).not.toContain('AWS_SECRET');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps entries over the size cap in memory only, and drops oversized legacy lines', async () => {
    const big = 'x'.repeat(MAX_ENTRY_BYTES + 1);
    const atCap = 'y'.repeat(MAX_ENTRY_BYTES);
    const store = new CommandHistoryStore(file, { persist: true });
    await store.load();
    store.add(atCap);
    store.add(big);
    await store.whenIdle();

    expect(await store.load()).toEqual([big, atCap]);
    expect(await freshLoad()).toEqual([atCap]);

    await fs.appendFile(file, line(big));
    expect(await freshLoad()).toEqual([atCap]);
    expect(await fileLines()).toHaveLength(1);
  });

  it('keeps every line intact when several sessions append at once', async () => {
    const sessions = Array.from({ length: 4 }, () => new CommandHistoryStore(file, { persist: true }));
    await Promise.all(sessions.map(session => session.load()));
    const bigEntry = (s: number, i: number) => `session ${s} entry ${i}\n${'x'.repeat(2000)}`;

    for (let i = 0; i < 25; i++) sessions.forEach((session, s) => session.add(bigEntry(s, i)));
    await Promise.all(sessions.map(session => session.whenIdle()));

    const lines = await fileLines();
    expect(lines).toHaveLength(100);
    for (const raw of lines) expect(() => JSON.parse(raw)).not.toThrow();
    const recalled = await freshLoad();
    expect(new Set(recalled).size).toBe(100);
    for (let s = 0; s < 4; s++) expect(recalled).toContain(bigEntry(s, 24));
    expect(await tmpFiles()).toEqual([]);
  });

  it('does not lose an entry another session appends while a compaction renames the file', async () => {
    await writeHistory(numbered(MAX_HISTORY_ENTRIES + 150));
    const other = new CommandHistoryStore(file, { persist: true });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      other.add('appended during compaction');
      // Without the lock this append lands in the old file, which the rename then discards.
      await new Promise(resolve => setTimeout(resolve, 100));
      await rename(from, to);
    });

    await freshLoad();
    await other.whenIdle();

    const lines = await fileLines();
    expect(lines).toHaveLength(MAX_HISTORY_ENTRIES + 1);
    expect(JSON.parse(lines[lines.length - 1]).command).toBe('appended during compaction');
    expect((await freshLoad())[0]).toBe('appended during compaction');
  });

  it('abandons a compaction when the file grew since it was read', async () => {
    const total = MAX_HISTORY_ENTRIES + 150;
    await writeHistory(numbered(total));
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (target, data, options) => {
      await writeFile(target, data, options);
      // A writer that does not take the lock, such as an older CLI.
      await fs.appendFile(file, line('unlocked writer'));
    });

    expect(await freshLoad()).toHaveLength(MAX_HISTORY_ENTRIES);

    const lines = await fileLines();
    expect(lines).toHaveLength(total + 1);
    expect(JSON.parse(lines[total]).command).toBe('unlocked writer');
    expect(await tmpFiles()).toEqual([]);

    vi.restoreAllMocks();
    expect((await freshLoad())[0]).toBe('unlocked writer');
    expect(await fileLines()).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it('takes over a lock left behind by a crashed session', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(`${file}.lock`, old, old);
    const store = new CommandHistoryStore(file, { persist: true });

    store.add('after crash');
    await store.whenIdle();

    expect(await freshLoad()).toEqual(['after crash']);
    expect(await tmpFiles()).toEqual([]);
  });

  it('writes nothing when persistence is off', async () => {
    const store = new CommandHistoryStore(file, { persist: false });
    await store.load();
    expect(store.add('memory only')).toEqual(['memory only']);
    await store.whenIdle();
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('turns persistence off with B4M_NO_HISTORY=1', async () => {
    const previous = process.env.B4M_NO_HISTORY;
    process.env.B4M_NO_HISTORY = '1';
    try {
      const store = new CommandHistoryStore(file);
      store.add('memory only');
      await store.whenIdle();
      await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.B4M_NO_HISTORY;
      else process.env.B4M_NO_HISTORY = previous;
    }
  });
});
