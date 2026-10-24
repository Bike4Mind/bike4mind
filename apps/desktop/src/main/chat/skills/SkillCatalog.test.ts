import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomCommandStore, RemoteSkillSource } from '@bike4mind/cli/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteSkillsKey } from './accountSkills';
import { ProjectTrustStore } from './ProjectTrustStore';
import { SkillCatalog, type RemoteSkills } from './SkillCatalog';

/**
 * The gate, not the loader. Discovery is the CLI's and has its own tests; what is proven here is
 * that a project's skills stay inert until the user says otherwise, that the decision survives a
 * restart, and that a session with no project cannot reach them at all.
 */
describe('SkillCatalog project trust', () => {
  let base: string;
  let project: string;
  let trustFile: string;

  const catalog = () => new SkillCatalog(new ProjectTrustStore(trustFile));

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-skills-')));
    project = join(base, 'repo');
    trustFile = join(base, 'trust.json');
    const skillDir = join(project, '.claude', 'skills', 'deploy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'description: Ship it', 'argument-hint: "[env]"', '---', '', 'Deploy to $1.'].join('\n'),
      'utf8'
    );
  });

  it('withholds a project skill until the project is trusted', async () => {
    const state = await catalog().state(project);
    expect(state.skills.some(skill => skill.name === 'deploy')).toBe(false);
    expect(state.untrustedProject).toBe(project);
    expect(state.projectDirectory).toBeNull();
  });

  it('refuses to resolve a withheld project skill for the send path', async () => {
    await expect(catalog().get(project, 'deploy')).resolves.toBeUndefined();
  });

  it('loads the project skill once trusted, and labels where it came from', async () => {
    const store = catalog();
    await store.setTrusted(project, true);

    const state = await store.state(project);
    const deploy = state.skills.find(skill => skill.name === 'deploy');
    expect(deploy).toMatchObject({ source: 'project', description: 'Ship it', argumentHint: '[env]' });
    expect(state.untrustedProject).toBeNull();
    expect(state.projectDirectory).toBe(project);
  });

  it('hands the model the same list until the catalog rescans, so its prompt is built once', async () => {
    const store = catalog();
    await store.setTrusted(project, true);
    const first = await store.forModel(project);
    expect(await store.forModel(project)).toBe(first);
    await store.setTrusted(project, false);
    expect(await store.forModel(project)).not.toBe(first);
  });

  it('remembers the decision across instances, so the user is asked once', async () => {
    await catalog().setTrusted(project, true);
    await expect(catalog().get(project, 'deploy')).resolves.toBeDefined();
  });

  it('withholds it again after the trust is revoked', async () => {
    const store = catalog();
    await store.setTrusted(project, true);
    await store.setTrusted(project, false);
    await expect(store.get(project, 'deploy')).resolves.toBeUndefined();
  });

  it('trusting one project says nothing about a sibling', async () => {
    const sibling = join(base, 'other-repo');
    await mkdir(join(sibling, '.claude', 'skills', 'deploy'), { recursive: true });
    await writeFile(join(sibling, '.claude', 'skills', 'deploy', 'SKILL.md'), 'Evil.', 'utf8');

    const store = catalog();
    await store.setTrusted(project, true);

    const state = await store.state(sibling);
    expect(state.untrustedProject).toBe(sibling);
    expect(state.skills.some(skill => skill.name === 'deploy')).toBe(false);
  });

  it('shows the model a trusted project skill, and an untrusted one to nobody', async () => {
    const store = catalog();
    expect((await store.forModel(project)).some(command => command.name === 'deploy')).toBe(false);

    await store.setTrusted(project, true);
    expect((await store.forModel(project)).some(command => command.name === 'deploy')).toBe(true);
  });

  it('keeps a not-model-invocable skill out of the model reach while leaving it in the picker', async () => {
    const skillDir = join(project, '.claude', 'skills', 'private-notes');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      ['---', 'description: Mine to run', 'disable-model-invocation: true', '---', '', 'Notes.'].join('\n'),
      'utf8'
    );

    const store = catalog();
    await store.setTrusted(project, true);

    // Two different questions: the composer asks what the USER may invoke, the prompt and the
    // skill tool ask what the MODEL may. This skill is the first and not the second.
    expect((await store.state(project)).skills.some(skill => skill.name === 'private-notes')).toBe(true);
    expect((await store.forModel(project)).some(command => command.name === 'private-notes')).toBe(false);
  });

  it('offers a skill folder once, never its supporting docs, to the picker and the skill tool alike', async () => {
    const skillDir = join(project, '.claude', 'skills', 'deploy');
    await mkdir(join(skillDir, 'references'), { recursive: true });
    await mkdir(join(skillDir, 'scripts', 'nested'), { recursive: true });
    await writeFile(join(skillDir, 'references', 'step-1-inspect.md'), '# Step 1', 'utf8');
    await writeFile(join(skillDir, 'README.md'), '# Readme', 'utf8');
    await writeFile(join(skillDir, 'scripts', 'nested', 'helper.md'), '# Helper', 'utf8');

    const store = catalog();
    await store.setTrusted(project, true);

    const picker = (await store.state(project)).skills.filter(skill => skill.source === 'project');
    const model = (await store.forModel(project)).filter(command => command.source === 'project');
    expect(picker.map(skill => skill.name)).toEqual(['deploy']);
    expect(model.map(command => command.name)).toEqual(['deploy']);
    await expect(store.get(project, 'step-1-inspect')).resolves.toBeUndefined();
    await expect(store.get(project, 'README')).resolves.toBeUndefined();
  });

  it('moves its revision only when trust changes, so a snapshot keyed on it holds otherwise', async () => {
    const store = catalog();
    const before = store.revision;
    await store.forModel(project);
    expect(store.revision).toBe(before);

    await store.setTrusted(project, true);
    expect(store.revision).not.toBe(before);
  });

  it('offers no project skill at all to a session with no project', async () => {
    const store = catalog();
    await store.setTrusted(project, true);

    // A Chat session passes null: it has no project binding, so a repo skill must not even be
    // advertised - it could not run here.
    const state = await store.state(null);
    expect(state.skills.every(skill => skill.source === 'global')).toBe(true);
    expect(state.projectDirectory).toBeNull();
    expect(state.untrustedProject).toBeNull();
  });
});

describe('SkillCatalog cache', () => {
  let project: string;
  let store: SkillCatalog;

  async function writeSkill(name: string, description: string): Promise<void> {
    const dir = join(project, '.claude', 'skills', name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      ['---', `description: ${description}`, '---', '', 'Body.'].join('\n'),
      'utf8'
    );
  }

  beforeEach(async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-skill-cache-')));
    project = join(base, 'repo');
    await writeSkill('deploy', 'Ship it');
    store = new SkillCatalog(new ProjectTrustStore(join(base, 'trust.json')));
    await store.setTrusted(project, true);
  });

  // FSEvents starts a new watch asynchronously, so a write in the same few milliseconds can be
  // missed. A user edits a skill long after the scan that set the watch up; the tests wait as well.
  const watchSettled = () => new Promise(resolve => setTimeout(resolve, 500));

  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers a repeat read without touching the disk', async () => {
    await store.state(project);
    const scans = vi.spyOn(CustomCommandStore.prototype, 'loadCommands');

    await store.state(project);
    await store.forModel(project);
    await store.get(project, 'deploy');

    expect(scans).not.toHaveBeenCalled();
  });

  it('rescans once a skill file changes, without moving the revision', async () => {
    await store.state(project);
    const revision = store.revision;
    await watchSettled();

    await writeSkill('review', 'Look it over');

    await vi.waitUntil(async () => (await store.state(project)).skills.some(skill => skill.name === 'review'), {
      timeout: 5000,
      interval: 50,
    });
    expect(store.revision).toBe(revision);
  });

  it("notices a project's first skill, written where no skill folder existed yet", async () => {
    const fresh = join(project, '..', 'fresh-repo');
    await mkdir(fresh, { recursive: true });
    await store.setTrusted(fresh, true);
    expect((await store.state(fresh)).skills.some(skill => skill.name === 'first')).toBe(false);
    await watchSettled();

    const dir = join(fresh, '.claude', 'skills', 'first');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), ['---', 'description: The first', '---', '', 'Body.'].join('\n'), 'utf8');

    // Well inside the 60s TTL, so only the watch on the folder above can have caught it.
    await vi.waitUntil(async () => (await store.state(fresh)).skills.some(skill => skill.name === 'first'), {
      timeout: 5000,
      interval: 50,
    });
  });

  it('rescans past the safety TTL even when no change was seen', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await store.state(project);
    const scans = vi.spyOn(CustomCommandStore.prototype, 'loadCommands');

    vi.setSystemTime(Date.now() + 61_000);
    await store.state(project);

    expect(scans).toHaveBeenCalledTimes(1);
  });
});

describe('SkillCatalog account skills', () => {
  let base: string;
  let project: string;
  let trustFile: string;
  let account: { userId: string; skills: unknown[] } | null;
  let fetches: number;
  let offline: boolean;

  // The real RemoteSkillSource over a stub client, so the owner and reserved-name filter under
  // test is the CLI's own, not a re-statement of it.
  const remote: RemoteSkills = () => {
    if (!account) return null;
    const { userId, skills } = account;
    const api = {
      get: async () => {
        fetches++;
        if (offline) throw new Error('backend unreachable');
        return { data: skills };
      },
      getCurrentUser: async () => ({ id: userId }),
    } as unknown as ConstructorParameters<typeof RemoteSkillSource>[0];
    const key = remoteSkillsKey('https://app.example.test', userId);
    return { key, source: new RemoteSkillSource(api, { cacheFilePath: join(base, `${key}.json`) }) };
  };
  const catalog = () => new SkillCatalog(new ProjectTrustStore(trustFile), remote);

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-account-skills-')));
    project = join(base, 'repo');
    trustFile = join(base, 'trust.json');
    fetches = 0;
    offline = false;
    const skillDir = join(project, '.claude', 'skills', 'deploy');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), ['---', 'description: Local deploy', '---', '', 'Local.'].join('\n'));
    account = {
      userId: 'me',
      skills: [
        { id: 'a1', name: 'web-summary', description: 'Summarise', body: 'Summarise $ARGUMENTS', userId: 'me' },
        { id: 'a2', name: 'deploy', description: 'Remote deploy', body: 'Remote.', userId: 'me' },
        { id: 'a3', name: 'theirs', description: 'Foreign', body: 'No.', userId: 'someone-else' },
        { id: 'a4', name: 'help', description: 'Reserved', body: 'No.', userId: 'me' },
      ],
    };
  });

  const names = async (store: SkillCatalog, root: string | null) =>
    (await store.state(root)).skills.filter(skill => skill.source === 'account').map(skill => skill.name);

  it('offers own account skills in a session with no project, labelled as account', async () => {
    const state = await catalog().state(null);
    expect(state.skills.find(skill => skill.name === 'web-summary')).toMatchObject({
      source: 'account',
      filePath: 'b4m:/api/skills/a1',
    });
  });

  it('never offers a foreign-owned or reserved-name skill', async () => {
    const offered = await names(catalog(), null);
    expect(offered).not.toContain('theirs');
    expect(offered).not.toContain('help');
  });

  it('offers account skills in an untrusted project while still withholding the project ones', async () => {
    const state = await catalog().state(project);
    expect(state.untrustedProject).toBe(project);
    expect(state.skills.find(skill => skill.name === 'web-summary')?.source).toBe('account');
    // The only `deploy` on offer is the account one; the repo's is withheld.
    expect(state.skills.find(skill => skill.name === 'deploy')?.source).toBe('account');
  });

  it('lets a local skill win a name collision in a trusted project, leaving one entry', async () => {
    const store = catalog();
    await store.setTrusted(project, true);
    const deploys = (await store.state(project)).skills.filter(skill => skill.name === 'deploy');
    expect(deploys).toEqual([expect.objectContaining({ source: 'project', description: 'Local deploy' })]);
    expect((await store.state(project)).skills.some(skill => skill.name === 'web-summary')).toBe(true);
  });

  it('reaches the model and the send path too', async () => {
    const store = catalog();
    expect((await store.forModel(null)).some(command => command.name === 'web-summary')).toBe(true);
    await expect(store.get(null, 'web-summary')).resolves.toMatchObject({ body: 'Summarise $ARGUMENTS' });
  });

  it('shows nothing from the account once signed out, without waiting out the scan cache', async () => {
    const store = catalog();
    expect(await names(store, null)).toContain('web-summary');

    account = null;
    expect(await names(store, null)).toEqual([]);
    expect((await store.forModel(null)).some(command => command.name === 'web-summary')).toBe(false);
    await expect(store.get(null, 'web-summary')).resolves.toBeUndefined();
  });

  it('serves the new account on a switch, and moves the revision so the prompt snapshot rebuilds', async () => {
    const store = catalog();
    expect(await names(store, null)).toContain('web-summary');
    const before = store.revision;

    account = {
      userId: 'other',
      skills: [{ id: 'b1', name: 'other-skill', description: 'd', body: 'b', userId: 'other' }],
    };
    expect(store.revision).not.toBe(before);
    expect(await names(store, null)).toEqual(['other-skill']);
  });

  it('holds its revision across ordinary reads by the same account', async () => {
    const store = catalog();
    const before = store.revision;
    await store.state(null);
    await store.forModel(null);
    expect(store.revision).toBe(before);
    expect(fetches).toBe(1);
  });

  it('still loads the local skills when the account fetch fails and there is no cache', async () => {
    const store = catalog();
    await store.setTrusted(project, true);
    offline = true;

    const state = await store.state(project);
    expect(state.skills.find(skill => skill.name === 'deploy')?.source).toBe('project');
    expect(state.skills.some(skill => skill.source === 'account')).toBe(false);
  });

  it('serves the cached account skills when a stale snapshot cannot be refreshed', async () => {
    const key = remoteSkillsKey('https://app.example.test', 'me');
    // Older than the source's 5-minute TTL, so the next fetch tries the network first.
    await writeFile(
      join(base, `${key}.json`),
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        skills: [{ id: 'a1', name: 'web-summary', description: 'Summarise', body: 'Offline.', userId: 'me' }],
      }),
      'utf8'
    );
    offline = true;

    expect(await names(catalog(), null)).toEqual(['web-summary']);
  });

  it('fetches the account once when the picker and the first turn read a cold catalog together', async () => {
    const store = catalog();
    await Promise.all([store.state(null), store.forModel(null)]);
    expect(fetches).toBe(1);
  });

  it('re-scans after the scan cache expires, so a settled read does not stick', async () => {
    const now = vi.spyOn(Date, 'now');
    const start = Date.now();

    try {
      const store = catalog();
      await Promise.all([store.state(null), store.forModel(null)]);
      expect(fetches).toBe(1);

      // Past the catalog's 2s scan cache AND the source's own 5-minute snapshot TTL, so the read
      // must walk the roots again rather than replay the promise the first read already settled.
      now.mockReturnValue(start + 6 * 60_000);

      expect(await names(store, null)).toContain('web-summary');
      expect(fetches).toBe(2);
    } finally {
      now.mockRestore();
    }
  });
});

describe('remoteSkillsKey', () => {
  it('differs per backend and per user, and is filename-safe', () => {
    const keys = new Set([
      remoteSkillsKey('https://app.bike4mind.com', 'u1'),
      remoteSkillsKey('https://app.bike4mind.com', 'u2'),
      remoteSkillsKey('http://localhost:3000', 'u1'),
    ]);
    expect(keys.size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is not fooled by a boundary shift between url and user id', () => {
    expect(remoteSkillsKey('https://a', 'bc')).not.toBe(remoteSkillsKey('https://ab', 'c'));
  });
});
