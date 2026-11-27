import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './__test__/helpers';
import { pullRequest } from './__test__/jobFixtures';
import { createAuditLog } from './audit';
import { createJobStore, type StoredJob } from './jobStore';
import { readOllamaKey } from './ollamaKey';

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function dir() {
  const made = await tempDir();
  cleanups.push(made.cleanup);
  return made.dir;
}

const record = (id: string, createdAt: string): StoredJob => ({
  request: pullRequest(),
  job: {
    id,
    state: 'downloading',
    source: 'hf',
    repo: 'org/repo',
    buildId: 'model-Q4_K_M',
    ref: 'hf.co/org/repo:Q4_K_M',
    sizeBytes: 1000,
    progress: { status: 'pulling', completedBytes: 10, totalBytes: 1000 },
    startedBy: { device: 'Laptop', user: null, via: 'local' },
    cancelledBy: null,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
    error: null,
    notice: null,
  },
});

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';

describe('createJobStore', () => {
  it('saves one file per job by rename and reads them back oldest first', async () => {
    const state = await dir();
    const logs: string[] = [];
    const store = createJobStore(state, line => logs.push(line));
    await store.save(record(ID_B, '2026-11-02T02:00:00.000Z'));
    await store.save(record(ID_A, '2026-11-02T01:00:00.000Z'));
    expect((await readdir(join(state, 'jobs'))).sort()).toEqual([`${ID_A}.json`, `${ID_B}.json`]);
    expect(((await stat(join(state, 'jobs', `${ID_A}.json`))).mode & 0o777).toString(8)).toBe('640');
    expect((await store.loadAll()).map(saved => saved.job.id)).toEqual([ID_A, ID_B]);
    await store.remove(ID_A);
    expect((await store.loadAll()).map(saved => saved.job.id)).toEqual([ID_B]);
    expect(logs).toEqual([]);
  });

  it('skips files that do not parse, do not match their name, or are symlinks', async () => {
    const state = await dir();
    const jobsDir = join(state, 'jobs');
    await mkdir(jobsDir, { recursive: true });
    await writeFile(join(jobsDir, `${ID_A}.json`), '{"job":');
    await writeFile(join(jobsDir, `${ID_B}.json`), JSON.stringify(record(ID_A, '2026-11-02T01:00:00.000Z')));
    const elsewhere = join(state, 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(record('00000000-0000-4000-8000-00000000000c', 'x')));
    await symlink(elsewhere, join(jobsDir, '00000000-0000-4000-8000-00000000000c.json'));
    await writeFile(join(jobsDir, 'notes.txt'), 'ignored');
    const logs: string[] = [];
    expect(await createJobStore(state, line => logs.push(line)).loadAll()).toEqual([]);
    expect(logs).toHaveLength(3);
  });

  it('deletes drafts a crash left before their rename, and keeps the run state', async () => {
    const state = await dir();
    const store = createJobStore(state, () => {});
    await store.save({
      ...record(ID_A, '2026-11-02T01:00:00.000Z'),
      run: { hadTag: false, pulled: true, afterOnly: true },
    });
    const draft = join(state, 'jobs', `${ID_B}.json.0123456789ab`);
    await writeFile(draft, '{"job":');
    const loaded = await store.loadAll();
    expect(loaded.map(saved => saved.run)).toEqual([{ hadTag: false, pulled: true, afterOnly: true }]);
    expect(await readdir(join(state, 'jobs'))).toEqual([`${ID_A}.json`]);
  });
});

describe('createAuditLog', () => {
  it('appends one JSON line per entry, in order', async () => {
    const state = await dir();
    const now = () => new Date('2026-11-02T00:00:00.000Z');
    const { audit, flush, path } = createAuditLog(state, () => {}, now);
    audit({ event: 'create', job: ID_A, ref: 'a:b', device: 'Laptop', login: 'ana', via: 'ssh' });
    audit({ event: 'cancel', job: ID_A });
    await flush();
    const text = await readFile(path, 'utf8');
    const lines = text.trim().split('\n');
    expect(lines.map(line => JSON.parse(line))).toEqual([
      { time: now().toISOString(), event: 'create', job: ID_A, ref: 'a:b', device: 'Laptop', login: 'ana', via: 'ssh' },
      { time: now().toISOString(), event: 'cancel', job: ID_A },
    ]);
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe('640');
  });

  it('moves a full log aside, keeping one previous file', async () => {
    const state = await dir();
    const { audit, flush, path } = createAuditLog(state, () => {}, undefined, 200);
    for (let i = 0; i < 8; i++) audit({ event: 'dismiss', job: ID_A, detail: `entry ${i}` });
    await flush();
    const lines = async (file: string) => (await readFile(file, 'utf8')).trim().split('\n');
    const current = await lines(path);
    const previous = await lines(`${path}.1`);
    expect((await readFile(path)).length).toBeLessThanOrEqual(200);
    expect(JSON.parse(current.at(-1)!).detail).toBe('entry 7');
    expect(previous.length + current.length).toBeLessThan(8);
    expect((await readdir(state)).sort()).toEqual(['audit.jsonl', 'audit.jsonl.1']);
  });
});

describe('readOllamaKey', () => {
  it('names the path and the sudo line when the key is unreadable, and refuses other content', async () => {
    const home = await dir();
    expect(await readOllamaKey(null)).toMatchObject({ path: null, publicKey: null });
    expect((await readOllamaKey(home)).message).toContain('has not created');
    await mkdir(join(home, '.ollama'));
    const path = join(home, '.ollama', 'id_ed25519.pub');
    await writeFile(path, 'not a key');
    expect((await readOllamaKey(home)).message).toBe(`${path} is not an Ollama public key.`);
    if (process.getuid?.() !== 0) {
      await writeFile(path, 'ssh-ed25519 AAAA');
      await chmod(path, 0o000);
      expect((await readOllamaKey(home)).message).toBe(
        `b4m-host cannot read ${path}. On the server, run: sudo cat ${path}`
      );
    }
  });
});
