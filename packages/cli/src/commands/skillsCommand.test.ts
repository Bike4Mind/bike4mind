import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { toSkillMd } from '@bike4mind/common/utils/skillMd';
import {
  buildSkillPayload,
  handleSkillsCommand,
  publishToMarket,
  pushSkill,
  readSkillFile,
  type PushDeps,
  type SkillFile,
} from './skillsCommand.js';

const handlerMocks = vi.hoisted(() => ({
  tokens: null as { expiresAt: string } | null,
  clearAuthTokens: vi.fn(),
  clearCache: vi.fn(),
  answer: 'n',
  apiClientArgs: [] as unknown[],
  api: {
    getCurrentUser: vi.fn().mockResolvedValue({ id: 'u1' }),
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../storage/ConfigStore.js', () => ({
  ConfigStore: class {
    load = async () => ({ apiConfig: undefined });
    getAuthTokens = async () => handlerMocks.tokens;
    clearAuthTokens = handlerMocks.clearAuthTokens;
  },
}));
vi.mock('../auth/ApiClient.js', () => ({
  ApiClient: class {
    constructor(...args: unknown[]) {
      handlerMocks.apiClientArgs = args;
      return handlerMocks.api;
    }
  },
}));
vi.mock('../storage/RemoteSkillSource.js', () => ({
  RemoteSkillSource: class {
    clearCache = handlerMocks.clearCache;
  },
}));
vi.mock('../utils/apiUrl.js', () => ({
  requireApiUrl: () => 'http://localhost',
}));
vi.mock('readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(handlerMocks.answer),
    close: () => {},
  }),
}));

const SKILL = `---
name: my-skill
description: Does a thing
argument-hint: <file>
allowed-tools: Read, Bash
model: opus
---
Body text
`;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-push-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeSkill(rel: string, content: string): Promise<string> {
  const p = path.join(dir, rel);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content);
  return p;
}

describe('readSkillFile', () => {
  it('reads <dir> and <dir>/SKILL.md the same way, keeping allowed-tools out of allowedTools', async () => {
    const file = await writeSkill('my-skill/SKILL.md', SKILL);
    const fromDir = await readSkillFile(path.dirname(file));
    const fromFile = await readSkillFile(file);
    expect(fromDir).toEqual(fromFile);
    expect(fromDir.payload).toEqual({
      name: 'my-skill',
      description: 'Does a thing',
      body: 'Body text',
      argumentHint: '<file>',
      claudeCodeAllowedTools: ['Read', 'Bash'],
      disableModelInvocation: false,
    });
    expect(fromDir.payload).not.toHaveProperty('allowedTools');
    expect(fromDir.dropped).toEqual(['model']);
  });

  it('falls back to the folder name, trimmed and lowercased', async () => {
    await writeSkill('My-Skill/SKILL.md', '---\ndescription: d\n---\nb\n');
    expect((await readSkillFile(path.join(dir, 'My-Skill'))).payload.name).toBe('my-skill');
  });

  it('uses the basename for a plain .md file and lists no supporting files', async () => {
    const file = await writeSkill('commands/review.md', 'Just a body\n');
    await writeSkill('commands/other.md', 'x');
    const read = await readSkillFile(file);
    expect(read.payload.name).toBe('review');
    expect(read.extraFiles).toEqual([]);
  });

  it('accepts an uppercase markdown extension and lowercases its fallback name', async () => {
    const file = await writeSkill('commands/Review.MD', 'Review a change\n');
    expect((await readSkillFile(file)).payload.name).toBe('review');
  });

  it('lists supporting files next to SKILL.md, skipping dotfiles', async () => {
    await writeSkill('s/SKILL.md', SKILL);
    await writeSkill('s/scripts/run.sh', 'x');
    await writeSkill('s/ref.md', 'x');
    await writeSkill('s/.DS_Store', 'x');
    expect((await readSkillFile(path.join(dir, 's'))).extraFiles).toEqual(['ref.md', 'scripts']);
  });

  it('expands a leading ~', async () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(dir);
    try {
      await writeSkill('s/SKILL.md', SKILL);
      expect((await readSkillFile('~/s')).payload.name).toBe('my-skill');
    } finally {
      homedir.mockRestore();
    }
  });

  it('treats a lowercase skill.md as the skill file, not as a supporting file', async () => {
    const file = await writeSkill('lower/skill.md', '---\nname: from-frontmatter\n---\nb\n');
    const read = await readSkillFile(file);
    expect(read.extraFiles).toEqual([]);

    const unnamed = await writeSkill('lower2/skill.md', 'Just a body\n');
    expect((await readSkillFile(unnamed)).payload.name).toBe('lower2');
  });

  it('rejects a missing path, a folder without SKILL.md, and a non-.md file', async () => {
    await expect(readSkillFile(path.join(dir, 'nope'))).rejects.toThrow('No such file or folder');
    await fs.mkdir(path.join(dir, 'empty'));
    await expect(readSkillFile(path.join(dir, 'empty'))).rejects.toThrow('No SKILL.md in that folder.');
    await expect(readSkillFile(await writeSkill('a.txt', 'x'))).rejects.toThrow('Not a skill');
  });

  it('surfaces a parse error', async () => {
    await expect(readSkillFile(await writeSkill('bad.md', '---\nname: x\n'))).rejects.toThrow('no closing');
  });
});

describe('buildSkillPayload', () => {
  it('maps disableModelInvocation and omits an absent argumentHint', () => {
    expect(buildSkillPayload({ name: ' X ', body: 'b', disableModelInvocation: true }, 'fallback')).toEqual({
      name: 'x',
      description: 'b',
      body: 'b',
      claudeCodeAllowedTools: [],
      disableModelInvocation: true,
    });
  });

  it("sends the file's allowed-tools as claudeCodeAllowedTools, never as allowedTools", () => {
    const payload = buildSkillPayload({ name: 'commit', claudeCodeAllowedTools: ['Bash(git:*)', 'Read'] }, 'f');
    expect(payload.claudeCodeAllowedTools).toEqual(['Bash(git:*)', 'Read']);
    expect(payload).not.toHaveProperty('allowedTools');
  });

  it('falls back to the first body line, without heading marks, when there is no description', () => {
    const body = '\n## Review the open PR\n\nThen summarize it.';
    expect(buildSkillPayload({ body }, 'f').description).toBe('Review the open PR');
    expect(buildSkillPayload({ description: '  ', body }, 'f').description).toBe('Review the open PR');
    expect(buildSkillPayload({ description: 'Given', body }, 'f').description).toBe('Given');
    expect(buildSkillPayload({ body: 'x'.repeat(600) }, 'f').description).toHaveLength(500);
    expect(buildSkillPayload({}, 'f').description).toBe('');
  });

  it('falls back to the file name when the frontmatter name is blank', () => {
    expect(buildSkillPayload({ name: '' }, 'Folder').name).toBe('folder');
    expect(buildSkillPayload({ name: '   ' }, 'folder').name).toBe('folder');
  });
});

const ME = { id: 'u1' };

function makeDeps(overrides: Partial<PushDeps> = {}, rows: object[] = []) {
  const api = {
    getCurrentUser: vi.fn().mockResolvedValue(ME),
    get: vi.fn().mockResolvedValue({ data: rows }),
    post: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
  };
  const lines: string[] = [];
  const deps: PushDeps = {
    api: api as unknown as PushDeps['api'],
    confirm: vi.fn().mockResolvedValue(false),
    isTTY: false,
    update: false,
    yes: false,
    apiOrigin: 'https://app.example',
    log: line => lines.push(line),
    ...overrides,
  };
  return { api, deps, lines };
}

const noApiCalls = (api: ReturnType<typeof makeDeps>['api']) =>
  Object.values(api).forEach(fn => expect(fn).not.toHaveBeenCalled());

const file = (extra: Partial<SkillFile> = {}): SkillFile => ({
  payload: { name: 'my-skill', description: 'd', body: 'b', claudeCodeAllowedTools: [], disableModelInvocation: false },
  dropped: [],
  extraFiles: [],
  ...extra,
});

describe('pushSkill', () => {
  it('creates when no own skill has the name, ignoring other users and near-matches', async () => {
    const { api, deps } = makeDeps({}, [
      { id: 's1', name: 'my-skill', userId: 'someone-else' },
      { id: 's2', name: 'my-skill-2', userId: 'u1' },
    ]);
    expect(await pushSkill(file(), deps)).toMatchObject({ outcome: 'created' });
    expect(api.get).toHaveBeenCalledWith('/api/skills', { params: { query: 'my-skill', limit: 100, page: 1 } });
    expect(api.post).toHaveBeenCalledWith('/api/skills', file().payload);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('prints dropped keys, supporting files (capped at 10) and the reserved-name note', async () => {
    const extraFiles = Array.from({ length: 12 }, (_, i) => `f${i}`);
    const { deps, lines } = makeDeps();
    await pushSkill(
      file({ dropped: ['allowed-tools', 'hooks'], extraFiles, payload: { ...file().payload, name: 'help' } }),
      deps
    );
    expect(lines).toContain('Ignored (not supported in Bike4Mind skills): allowed-tools, hooks');
    expect(lines.find(l => l.startsWith('Not uploaded'))).toContain('and 2 more');
    expect(lines.find(l => l.startsWith('Not uploaded'))).not.toContain('f10');
    expect(lines.some(l => l.includes('/help is a built-in'))).toBe(true);
  });

  describe('existing own skill', () => {
    const rows = [{ id: 's1', name: 'my-skill', userId: 'u1' }];

    it('--update sends a PUT', async () => {
      const { api, deps } = makeDeps({ update: true }, rows);
      expect(await pushSkill(file(), deps)).toMatchObject({ outcome: 'updated' });
      expect(api.put).toHaveBeenCalledWith('/api/skills/s1', { ...file().payload, argumentHint: '' });
      expect(api.post).not.toHaveBeenCalled();
    });

    it('TTY prompt yes sends a PUT', async () => {
      const { api, deps } = makeDeps({ isTTY: true, confirm: vi.fn().mockResolvedValue(true) }, rows);
      expect(await pushSkill(file(), deps)).toMatchObject({ outcome: 'updated' });
      expect(api.put).toHaveBeenCalled();
    });

    it('clears a removed argument hint when updating, but preserves an explicit hint', async () => {
      const { api, deps } = makeDeps({ update: true }, rows);
      await pushSkill(file(), deps);
      expect(api.put).toHaveBeenLastCalledWith('/api/skills/s1', { ...file().payload, argumentHint: '' });

      const withHint = file({ payload: { ...file().payload, argumentHint: '<topic>' } });
      await pushSkill(withHint, deps);
      expect(api.put).toHaveBeenLastCalledWith('/api/skills/s1', withHint.payload);
    });

    it('TTY prompt no aborts without writing', async () => {
      const { api, deps } = makeDeps({ isTTY: true }, rows);
      expect(await pushSkill(file(), deps)).toEqual({ outcome: 'aborted' });
      expect(api.put).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
    });

    it('non-TTY without --update fails with the hint', async () => {
      const { api, deps } = makeDeps({}, rows);
      await expect(pushSkill(file(), deps)).rejects.toThrow('re-run with --update');
      expect(api.put).not.toHaveBeenCalled();
    });

    it('refuses to overwrite a market import, even with --update', async () => {
      const { api, deps } = makeDeps({ update: true }, [{ ...rows[0], importedFrom: { listingId: 'l1' } }]);
      await expect(pushSkill(file(), deps)).rejects.toThrow('delete the import first');
      expect(api.put).not.toHaveBeenCalled();
    });
  });

  describe('stamped files', () => {
    const own = file({ source: { url: 'https://app.example/skills/1', thirdParty: false } });
    const thirdParty = file({ source: { url: 'https://app.example/market/1', thirdParty: true } });

    it('an own export prints the source notice and pushes', async () => {
      const { api, deps, lines } = makeDeps();
      expect(await pushSkill(own, deps)).toMatchObject({ outcome: 'created' });
      expect(lines).toContain('This skill came from Bike4Mind: https://app.example/skills/1');
      expect(api.post).toHaveBeenCalled();
    });

    it('words a stamp from another origin as unverified', async () => {
      const { api, deps, lines } = makeDeps();
      const foreign = file({ source: { url: 'https://evil.example/x', thirdParty: false } });
      expect(await pushSkill(foreign, deps)).toMatchObject({ outcome: 'created' });
      expect(lines).toContain('This file has a Bike4Mind source stamp from another site: https://evil.example/x');
      expect(lines).not.toContain('This skill came from Bike4Mind: https://evil.example/x');
      expect(api.post).toHaveBeenCalled();
    });

    it('third-party in a TTY: no aborts with no API call', async () => {
      const { api, deps, lines } = makeDeps({ isTTY: true });
      expect(await pushSkill(thirdParty, deps)).toEqual({ outcome: 'aborted' });
      expect(deps.confirm).toHaveBeenCalledWith('Push it as your own skill anyway? [y/N] ');
      expect(lines.some(l => l.includes("another author's Skill Market skill"))).toBe(true);
      noApiCalls(api);
    });

    it('third-party in a TTY: yes pushes', async () => {
      const { api, deps } = makeDeps({ isTTY: true, confirm: vi.fn().mockResolvedValue(true) });
      expect(await pushSkill(thirdParty, deps)).toMatchObject({ outcome: 'created' });
      expect(api.post).toHaveBeenCalled();
    });

    it('third-party non-TTY without --yes fails with no API call', async () => {
      const { api, deps } = makeDeps();
      await expect(pushSkill(thirdParty, deps)).rejects.toThrow('--yes');
      noApiCalls(api);
    });

    it('third-party with --yes pushes without prompting', async () => {
      const { api, deps } = makeDeps({ yes: true });
      expect(await pushSkill(thirdParty, deps)).toMatchObject({ outcome: 'created' });
      expect(deps.confirm).not.toHaveBeenCalled();
      expect(api.post).toHaveBeenCalled();
    });

    it('stamp lines are never reported as dropped', async () => {
      const text = toSkillMd(
        { name: 'x', description: 'd', body: 'b' },
        { sourceUrl: 'https://app.example/market/1', version: 2, exportedAt: new Date(), thirdParty: true }
      );
      const read = await readSkillFile(await writeSkill('x.md', text));
      expect(read.dropped).toEqual([]);
      expect(read.source).toEqual({ url: 'https://app.example/market/1', thirdParty: true });
    });
  });

  it('passes a server error message through', async () => {
    const { api, deps } = makeDeps();
    api.post.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 400'), {
        response: { data: { error: 'Name must be kebab-case' } },
      })
    );
    await expect(pushSkill(file(), deps)).rejects.toThrow('Name must be kebab-case');
  });

  it('falls back to the server message field when the error field is absent', async () => {
    const { api, deps } = makeDeps({ update: true }, [{ id: 's1', name: 'my-skill', userId: 'u1' }]);
    api.put.mockRejectedValue({ response: { data: { message: 'Forbidden' } } });
    await expect(pushSkill(file(), deps)).rejects.toThrow('Forbidden');
  });

  it('reports a failed current-user lookup without touching skills', async () => {
    const { api, deps } = makeDeps();
    api.getCurrentUser.mockRejectedValue(new Error('Authentication expired. Please run `b4m login` again.'));
    await expect(pushSkill(file(), deps)).rejects.toThrow('Authentication expired');
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('does not create a skill when the existing-skill lookup fails', async () => {
    const { api, deps } = makeDeps();
    api.get.mockRejectedValue(new Error('Skill lookup unavailable'));
    await expect(pushSkill(file(), deps)).rejects.toThrow('Skill lookup unavailable');
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('reports an update failure without retrying it as a create', async () => {
    const { api, deps } = makeDeps({ update: true }, [{ id: 's1', name: 'my-skill', userId: 'u1' }]);
    api.put.mockRejectedValue(new Error('Update rejected'));
    await expect(pushSkill(file(), deps)).rejects.toThrow('Update rejected');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('fails with the login hint when there is no current user', async () => {
    const { api, deps } = makeDeps();
    api.getCurrentUser.mockResolvedValue(null);
    await expect(pushSkill(file(), deps)).rejects.toThrow('b4m /login');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('pages the lookup until it finds the own skill', async () => {
    const { api, deps } = makeDeps({ update: true });
    api.get
      .mockResolvedValueOnce({ data: [{ id: 'x', name: 'other', userId: ME.id }], hasMore: true })
      .mockResolvedValueOnce({ data: [{ id: 'id1', name: 'my-skill', userId: ME.id }], hasMore: false });
    await expect(pushSkill(file(), deps)).resolves.toMatchObject({ outcome: 'updated' });
    expect(api.get).toHaveBeenLastCalledWith('/api/skills', { params: { query: 'my-skill', limit: 100, page: 2 } });
    expect(api.put).toHaveBeenCalledWith('/api/skills/id1', expect.anything());
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('handleSkillsCommand', () => {
  const ARGS = { _: ['skills', 'push'], path: '' };
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.stubEnv('B4M_API_KEY', '');
    ARGS.path = path.dirname(await writeSkill('my-skill/SKILL.md', SKILL));
    handlerMocks.tokens = { expiresAt: new Date(Date.now() + 60_000).toISOString() };
    handlerMocks.api.get.mockResolvedValue({ data: [] });
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it('fails with the login hint and no API call when there are no tokens', async () => {
    handlerMocks.tokens = null;
    await expect(handleSkillsCommand('push', ARGS)).rejects.toThrow('b4m /login');
    expect(handlerMocks.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown or missing subcommand', async () => {
    await expect(handleSkillsCommand('pull', ARGS)).rejects.toThrow('Unknown skills subcommand: pull');
    await expect(handleSkillsCommand(undefined, ARGS)).rejects.toThrow('Unknown skills subcommand: (none)');
    expect(handlerMocks.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('rejects an empty path before reading or making an API call', async () => {
    await expect(handleSkillsCommand('push', { ...ARGS, path: '' })).rejects.toThrow('Usage: b4m skills push <path>');
    expect(handlerMocks.api.getCurrentUser).not.toHaveBeenCalled();
  });

  it('lets the API client refresh a stale access token instead of dropping the session', async () => {
    handlerMocks.tokens = { expiresAt: new Date(Date.now() - 1000).toISOString() };
    await handleSkillsCommand('push', ARGS);
    expect(handlerMocks.clearAuthTokens).not.toHaveBeenCalled();
    expect(handlerMocks.api.getCurrentUser).toHaveBeenCalled();
  });

  it('passes --update through and reports the update', async () => {
    handlerMocks.api.get.mockResolvedValue({ data: [{ id: 'id1', name: 'my-skill', userId: 'u1' }] });
    await handleSkillsCommand('push', { ...ARGS, update: true });
    expect(handlerMocks.api.put).toHaveBeenCalledWith('/api/skills/id1', expect.objectContaining({ name: 'my-skill' }));
    expect(handlerMocks.api.post).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Updated skill /my-skill');
  });

  it('clears the remote-skills cache after a write', async () => {
    await handleSkillsCommand('push', ARGS);
    expect(handlerMocks.api.post).toHaveBeenCalled();
    expect(handlerMocks.clearCache).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Created skill /my-skill');
  });

  it('reports the successful write and warns when clearing the local cache fails', async () => {
    handlerMocks.clearCache.mockRejectedValueOnce(new Error('Permission denied'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(handleSkillsCommand('push', ARGS)).resolves.toBeUndefined();
      expect(handlerMocks.api.post).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith('Created skill /my-skill');
      expect(warnSpy).toHaveBeenCalledWith(
        'Skill saved, but the local skills cache could not be cleared: Permission denied'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('prints Aborted and leaves the cache alone when the user declines', async () => {
    handlerMocks.api.get.mockResolvedValue({ data: [{ id: 'id1', name: 'my-skill', userId: ME.id }] });
    const isTTY = process.stdin.isTTY;
    process.stdin.isTTY = true;
    try {
      await handleSkillsCommand('push', ARGS);
    } finally {
      process.stdin.isTTY = isTTY;
    }
    expect(handlerMocks.api.put).not.toHaveBeenCalled();
    expect(handlerMocks.clearCache).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Aborted');
  });
});

describe('publishToMarket', () => {
  const VERSION = { version: 2, scan_status: 'passed', review_status: 'auto_approved', risk_tier: 'clean' };
  const listing = (status: string) => ({ id: 'l1', name: 'my-skill', status, visibility: 'organization' });

  function api(mine: unknown[]) {
    return {
      get: vi.fn().mockResolvedValue({ data: mine, next_cursor: null }),
      post: vi.fn().mockResolvedValue({ listing: listing('approved'), version: VERSION }),
    };
  }

  it('publishes a new listing when the skill has none', async () => {
    const a = api([]);
    const lines: string[] = [];
    await publishToMarket('s1', { visibility: 'organization', tags: ['ci'] }, a as never, l => lines.push(l));
    expect(a.get).toHaveBeenCalledWith('/api/v1/skills/market/listings/mine', { params: { source_skill_id: 's1' } });
    expect(a.post).toHaveBeenCalledWith('/api/v1/skills/market/listings', {
      skill_id: 's1',
      visibility: 'organization',
      tags: ['ci'],
    });
    expect(lines).toEqual([
      'Published listing "my-skill" (organization): scan passed, review auto_approved, risk clean',
    ]);
  });

  it('sends --org as organization_id', async () => {
    const a = api([]);
    await publishToMarket('s1', { visibility: 'organization', org: 'o1' }, a as never, () => {});
    expect(a.post.mock.calls[0][1]).toEqual({ skill_id: 's1', visibility: 'organization', organization_id: 'o1' });
  });

  it('submits a new version of the live listing', async () => {
    const a = api([listing('approved')]);
    a.post.mockResolvedValue({ listing: listing('approved'), version: { ...VERSION, review_status: 'pending' } });
    const lines: string[] = [];
    await publishToMarket('s1', { visibility: 'public' }, a as never, l => lines.push(l));
    expect(a.post).toHaveBeenCalledWith('/api/v1/skills/market/listings/l1/versions', {});
    expect(lines[0]).toBe(
      'Submitted version 2 of listing "my-skill": scan passed, review pending, risk clean - it goes live once a reviewer approves it'
    );
  });

  it('publishes afresh when the only listing was withdrawn', async () => {
    const a = api([listing('withdrawn')]);
    await publishToMarket('s1', { visibility: 'unlisted' }, a as never, () => {});
    expect(a.post).toHaveBeenCalledWith('/api/v1/skills/market/listings', { skill_id: 's1', visibility: 'unlisted' });
  });

  it('reports an unchanged re-publish as up to date', async () => {
    const a = api([listing('approved')]);
    a.post.mockRejectedValue({
      response: { status: 400, data: { error: 'This exact content is already live or waiting for review' } },
    });
    const lines: string[] = [];
    await publishToMarket('s1', { visibility: 'public' }, a as never, l => lines.push(l));
    expect(lines).toEqual(['Listing "my-skill" is already up to date']);
  });

  it('still fails on any other 400 from the versions endpoint', async () => {
    const a = api([listing('approved')]);
    a.post.mockRejectedValue({ response: { status: 400, data: { error: 'Skill has no content' } } });
    await expect(publishToMarket('s1', { visibility: 'public' }, a as never, () => {})).rejects.toThrow(
      'Publishing to the Skill Market failed: Skill has no content'
    );
  });

  it("surfaces the server's refusal", async () => {
    const a = api([]);
    a.post.mockRejectedValue({ response: { status: 403, data: { error: 'The API key lacks skills:write' } } });
    await expect(publishToMarket('s1', { visibility: 'public' }, a as never, () => {})).rejects.toThrow(
      'Publishing to the Skill Market failed: The API key lacks skills:write'
    );
  });

  it("names the scope a key's 403 asks for", async () => {
    const a = api([]);
    a.get.mockRejectedValue({
      response: { status: 403, data: { error: 'Insufficient scope', required_scopes: ['skills:write'] } },
    });
    await expect(publishToMarket('s1', { visibility: 'public' }, a as never, () => {})).rejects.toThrow(
      'Publishing to the Skill Market failed: Insufficient scope (the API key needs skills:write)'
    );
    expect(a.post).not.toHaveBeenCalled();
  });
});

describe('handleSkillsCommand with an API key', () => {
  const ARGS = { _: ['skills', 'push'], path: '' };
  let logSpy: ReturnType<typeof vi.spyOn>;
  const savedKey = process.env.B4M_API_KEY;

  beforeEach(async () => {
    ARGS.path = path.dirname(await writeSkill('my-skill/SKILL.md', SKILL));
    handlerMocks.tokens = null;
    vi.clearAllMocks();
    process.env.B4M_API_KEY = 'b4m_live_env';
    handlerMocks.api.get.mockImplementation(async (url: string) =>
      url === '/api/v1/me' ? { id: 'u1' } : { data: [], next_cursor: null }
    );
    handlerMocks.api.post.mockImplementation(async (url: string) =>
      url === '/api/skills'
        ? { id: 'new-skill' }
        : {
            listing: { id: 'l1', name: 'my-skill', visibility: 'organization' },
            version: { version: 1, scan_status: 'passed', review_status: 'auto_approved', risk_tier: 'clean' },
          }
    );
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    if (savedKey === undefined) delete process.env.B4M_API_KEY;
    else process.env.B4M_API_KEY = savedKey;
    handlerMocks.api.get.mockReset();
    handlerMocks.api.post.mockReset().mockResolvedValue({});
  });

  it('authenticates with B4M_API_KEY and resolves the owner via /api/v1/me, not the stored login', async () => {
    await handleSkillsCommand('push', ARGS);
    expect(handlerMocks.apiClientArgs[2]).toBe('b4m_live_env');
    expect(handlerMocks.api.get).toHaveBeenCalledWith('/api/v1/me');
    expect(handlerMocks.api.getCurrentUser).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith('Created skill /my-skill');
  });

  it('prefers --api-key over B4M_API_KEY', async () => {
    await handleSkillsCommand('push', { ...ARGS, 'api-key': 'b4m_live_flag' });
    expect(handlerMocks.apiClientArgs[2]).toBe('b4m_live_flag');
  });

  it('explains the scopes a key needs when /api/v1/me refuses it', async () => {
    handlerMocks.api.get.mockRejectedValue({ response: { status: 403, data: { error: 'Forbidden' } } });
    await expect(handleSkillsCommand('push', ARGS)).rejects.toThrow('me:read and skills:write');
    expect(handlerMocks.api.post).not.toHaveBeenCalled();
  });

  it("surfaces any other /api/v1/me failure as the server's message, without the scope hint", async () => {
    handlerMocks.api.get.mockRejectedValue({ response: { status: 401, data: { error: 'Invalid API key' } } });
    const failure = handleSkillsCommand('push', ARGS);
    await expect(failure).rejects.toThrow('Invalid API key');
    await expect(failure).rejects.not.toThrow('me:read');
    expect(handlerMocks.api.post).not.toHaveBeenCalled();
  });

  it('pushes then publishes the created skill with --publish', async () => {
    await handleSkillsCommand('push', { ...ARGS, publish: true, tags: 'ci, review,,' });
    expect(handlerMocks.api.post).toHaveBeenNthCalledWith(2, '/api/v1/skills/market/listings', {
      skill_id: 'new-skill',
      visibility: 'organization',
      tags: ['ci', 'review'],
    });
    expect(logSpy).toHaveBeenCalledWith(
      'Published listing "my-skill" (organization): scan passed, review auto_approved, risk clean'
    );
  });

  it('does not publish without --publish', async () => {
    await handleSkillsCommand('push', ARGS);
    expect(handlerMocks.api.post).toHaveBeenCalledTimes(1);
  });
});
