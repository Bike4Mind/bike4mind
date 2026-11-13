import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gitFreshLocation,
  gitOnBranchIncludes,
  gitPrettyConfig,
  gitSigningConfig,
  type GitSigningCall,
} from './shellWrites';

describe('signing config queries', () => {
  let base = '';
  let repo = '';
  const call = (settings: string[] = [], env: Record<string, string> = {}): GitSigningCall => ({
    gitDir: null,
    workTree: null,
    settings,
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', ...env },
  });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-signing-')));
    repo = join(base, 'repo');
    execFileSync('git', ['init', '-q', repo]);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('hands the query a --config-env variable although git calls named GIT_ are dropped', async () => {
    for (const name of ['SIGNV', 'GIT_SIGNV']) {
      const settings = ['--config-env', `commit.gpgsign=${name}`];
      expect(await gitSigningConfig(repo, call(settings, { [name]: 'true' }))).toEqual([
        { key: 'commit.gpgsign', value: 'true' },
      ]);
      expect(await gitSigningConfig(repo, call([`--config-env=commit.gpgsign=${name}`], { [name]: 'false' }))).toEqual([
        { key: 'commit.gpgsign', value: 'false' },
      ]);
    }
  });

  it('fails the query for a --config-env variable it is not given', async () => {
    expect(await gitSigningConfig(repo, call(['--config-env', 'commit.gpgsign=SIGNV_NONE']))).toBeNull();
    expect(await gitPrettyConfig(repo, call(['--config-env=format.pretty=SIGNV_NONE']))).toBeNull();
  });

  it('reads no config as none, and a folder that does not exist as a failure', async () => {
    expect(await gitSigningConfig(repo, call())).toEqual([]);
    expect(await gitPrettyConfig(repo, call())).toEqual([]);
    expect(await gitSigningConfig(join(base, 'missing'), call())).toBeNull();
    expect(await gitPrettyConfig(join(base, 'missing'), call())).toBeNull();
    expect(await gitSigningConfig(join(base, 'missing', 'deeper'), call())).toBeNull();
  });

  it('reads format.pretty and every pretty alias, with their values', async () => {
    expect(
      await gitPrettyConfig(
        repo,
        call(['-c', 'format.pretty=sig', '-c', 'pretty.sig=format:%h %G?', '-c', 'user.name=x'])
      )
    ).toEqual([
      { key: 'format.pretty', value: 'sig' },
      { key: 'pretty.sig', value: 'format:%h %G?' },
    ]);
  });

  it('reads a value with a newline in it as one entry', async () => {
    const entries = await gitPrettyConfig(repo, call(['--config-env=format.pretty=MULTI'], { MULTI: 'a\npretty.x b' }));
    expect(entries).toEqual([{ key: 'format.pretty', value: 'a\npretty.x b' }]);
  });

  it('reads a key set without a value as null', async () => {
    appendFileSync(join(repo, '.git', 'config'), '[format]\n\tpretty\n');
    expect(await gitPrettyConfig(repo, call())).toEqual([{ key: 'format.pretty', value: null }]);
  });
});

describe('queries about config a statement may change', () => {
  let base = '';
  let repo = '';
  let global = '';
  const call = (settings: string[] = []): GitSigningCall => ({
    gitDir: null,
    workTree: null,
    settings,
    env: { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_SYSTEM: '/dev/null' },
  });

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'b4m-fresh-')));
    repo = join(base, 'repo');
    global = join(base, 'global-gitconfig');
    execFileSync('git', ['init', '-q', repo]);
    appendFileSync(join(repo, '.git', 'config'), '[commit]\n\tgpgsign = true\n');
    mkdirSync(join(repo, 'sub'));
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(global, { force: true });
    vi.unstubAllEnvs();
  });

  it('lists an includeIf onbranch whichever branch is out, and none as none', async () => {
    expect(await gitOnBranchIncludes(repo, call())).toBe('none');
    writeFileSync(global, '[includeIf "gitdir:~/x/"]\n\tpath = /dev/null\n');
    expect(await gitOnBranchIncludes(repo, call())).toBe('none');
    writeFileSync(global, '[includeIf "onbranch:feat/*"]\n\tpath = /dev/null\n');
    expect(await gitOnBranchIncludes(repo, call())).toBe('some');
    expect(await gitOnBranchIncludes(base, call())).toBe('some');
    expect(await gitOnBranchIncludes(repo, call(['-c', 'includeIf.onbranch:x.path=/dev/null']))).toBe('some');
  });

  it('fails the onbranch query for a folder that does not exist and for config git cannot read', async () => {
    expect(await gitOnBranchIncludes(join(base, 'missing'), call())).toBeNull();
    writeFileSync(global, '[includeIf "onbranch:x"\n');
    expect(await gitOnBranchIncludes(repo, call())).toBeNull();
  });

  it('places a new repository where no enclosing repository config is read', async () => {
    writeFileSync(global, '[user]\n\tname = x\n');
    for (const near of [join(repo, 'sub'), join(repo, 'sub', 'not', 'there', 'yet'), repo, join(repo, 'missing')]) {
      const fresh = await gitFreshLocation(near, call());
      expect(fresh, near).not.toBeNull();
      expect(await gitSigningConfig(fresh?.folder as string, fresh?.call as GitSigningCall), near).toEqual([]);
      expect(fresh?.call.env.GIT_CEILING_DIRECTORIES).toBe(dirname(fresh?.folder as string));
      expect(fresh?.call.env.GIT_CONFIG_GLOBAL).toBe(global);
    }
    // The same folder does read the repository's own commit.gpgsign.
    expect(await gitSigningConfig(join(repo, 'sub'), call())).toEqual([{ key: 'commit.gpgsign', value: 'true' }]);
  });

  it('reads the global config for the new repository, with the call settings', async () => {
    writeFileSync(global, '[commit]\n\tgpgsign = true\n');
    const fresh = await gitFreshLocation(join(repo, 'sub'), call(['-c', 'tag.gpgsign=true']));
    expect(await gitSigningConfig(fresh?.folder as string, fresh?.call as GitSigningCall)).toEqual([
      { key: 'commit.gpgsign', value: 'true' },
      { key: 'tag.gpgsign', value: 'true' },
    ]);
  });

  it.each([
    ['an includeIf', '[includeIf "gitdir:~/x/"]\n\tpath = /dev/null\n'],
    ['an includeIf onbranch', '[includeIf "onbranch:x"]\n\tpath = /dev/null\n'],
    ['an includeIf hasconfig', '[includeIf "hasconfig:remote.*.url:*"]\n\tpath = /dev/null\n'],
    ['init.templateDir', '[init]\n\ttemplateDir = /dev/null\n'],
    ['init.templateDir in another case', '[INIT]\n\tTemplateDir = /dev/null\n'],
    ['config git cannot read', '[init\n'],
  ])('declines a new repository when the config has %s', async (_name, text) => {
    writeFileSync(global, text);
    expect(await gitFreshLocation(join(repo, 'sub'), call())).toBeNull();
  });

  it('declines for a template or include set by -c', async () => {
    expect(await gitFreshLocation(join(repo, 'sub'), call(['-c', 'init.templateDir=/dev/null']))).toBeNull();
    expect(await gitFreshLocation(join(repo, 'sub'), call(['-c', 'includeIf.gitdir:/x/.path=/dev/null']))).toBeNull();
  });

  it.each(['GIT_TEMPLATE_DIR', 'GIT_EXEC_PATH'])('declines when this process sets %s', async name => {
    expect(await gitFreshLocation(join(repo, 'sub'), call())).not.toBeNull();
    vi.stubEnv(name, '/dev/null');
    expect(await gitFreshLocation(join(repo, 'sub'), call())).toBeNull();
  });

  it('declines for a git dir, a work tree and a folder under a file', async () => {
    expect(await gitFreshLocation(join(repo, 'sub'), { ...call(), gitDir: '.git' })).toBeNull();
    expect(await gitFreshLocation(join(repo, 'sub'), { ...call(), workTree: '.' })).toBeNull();
    writeFileSync(join(base, 'file'), 'x');
    expect(await gitFreshLocation(join(base, 'file', 'under'), call())).toBeNull();
  });

  it('goes above a folder that holds a .git of any kind', async () => {
    const odd = join(base, 'odd');
    mkdirSync(odd);
    symlinkSync('loop', join(odd, '.git'));
    expect(await gitFreshLocation(odd, call())).not.toBeNull();
    rmSync(join(odd, '.git'), { force: true });
    writeFileSync(join(odd, '.git'), 'x');
    expect(await gitFreshLocation(join(odd, 'sub'), call())).not.toBeNull();
  });
});
