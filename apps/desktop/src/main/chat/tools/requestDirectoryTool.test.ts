import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { broadPathWarning, inspectDirectoryRequest, requestDirectory } from './requestDirectoryTool';

describe('inspectDirectoryRequest', () => {
  let base: string;
  let home: string;
  let wanted: string;

  const inspect = (path: string, extra: { roots?: string[]; declined?: string[]; protectedPaths?: string[] } = {}) =>
    inspectDirectoryRequest(
      { path, reason: 'Edit the skill file.' },
      { roots: extra.roots ?? [], declined: extra.declined ?? [], home, protectedPaths: extra.protectedPaths ?? [] }
    );

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'b4m-request-dir-')));
    home = join(base, 'home');
    wanted = join(home, 'notes');
    await mkdir(wanted, { recursive: true });
  });

  it('asks for an existing folder, expanding ~', async () => {
    await expect(inspect('~/notes')).resolves.toEqual({ kind: 'ask', path: wanted, reason: 'Edit the skill file.' });
  });

  it('refuses the filesystem root outright', async () => {
    const result = await inspect('/');
    expect(result).toMatchObject({ kind: 'refused' });
    expect(result.kind === 'refused' && result.message).toMatch(/root cannot be shared/);
  });

  it('warns on, but still asks for, the home folder itself', async () => {
    const result = await inspect('~');
    expect(result).toMatchObject({ kind: 'ask', path: home });
    expect(result.kind === 'ask' && result.warning).toMatch(/whole home folder/);
  });

  it('refuses a file and a missing path with the same wording', async () => {
    await writeFile(join(wanted, 'a.md'), 'x', 'utf8');
    const file = await inspect(join(wanted, 'a.md'));
    const missing = await inspect(join(wanted, 'nope'));
    expect(file).toMatchObject({ kind: 'refused' });
    expect(missing).toMatchObject({ kind: 'refused' });
    const wording = (result: typeof file) => (result.kind === 'refused' ? result.message.replace(/^\S+/, '') : '');
    expect(wording(file)).toBe(wording(missing));
  });

  it('shows and grants the target of a symlink, never the name that was asked for', async () => {
    const target = join(base, 'elsewhere');
    await mkdir(target);
    await symlink(target, join(home, 'link'));
    await expect(inspect('~/link')).resolves.toMatchObject({ kind: 'ask', path: target });
  });

  it('collapses traversal before deciding', async () => {
    await expect(inspect(`${wanted}/../notes/./`)).resolves.toMatchObject({ kind: 'ask', path: wanted });
  });

  it('returns at once for a folder already inside a root', async () => {
    await expect(inspect(wanted, { roots: [home] })).resolves.toEqual({ kind: 'inside', path: wanted });
  });

  it('refuses a folder declined earlier in the turn, and anything beneath it', async () => {
    await mkdir(join(wanted, 'deeper'));
    const result = await inspect(join(wanted, 'deeper'), { declined: [wanted] });
    expect(result.kind === 'refused' && result.message).toMatch(/already declined/);
  });

  it("refuses the app's own protected folders", async () => {
    await expect(inspect(wanted, { protectedPaths: [home] })).resolves.toMatchObject({ kind: 'refused' });
  });

  it('requires a reason', async () => {
    const result = await inspectDirectoryRequest({ path: wanted, reason: '  ' }, { roots: [], declined: [], home });
    expect(result).toMatchObject({ kind: 'refused' });
  });
});

describe('broadPathWarning', () => {
  it('names the home folder, its parent, credential folders and system folders', () => {
    expect(broadPathWarning('/Users/someone', '/Users/someone')).toMatch(/whole home folder/);
    expect(broadPathWarning('/Users', '/Users/someone')).toMatch(/contains your whole home folder/);
    expect(broadPathWarning('/Users/someone/.ssh', '/Users/someone')).toMatch(/credentials/);
    expect(broadPathWarning('/etc', '/Users/someone')).toMatch(/system folder/);
    expect(broadPathWarning('/private/etc', '/Users/someone')).toMatch(/system folder/);
  });

  it('leaves an ordinary project and the temp folders alone', () => {
    expect(broadPathWarning('/Users/someone/code/app', '/Users/someone')).toBeUndefined();
    expect(broadPathWarning('/private/var/folders/x/T/work', '/Users/someone', ['/private/var/folders/x/T'])).toBe(
      undefined
    );
  });
});

describe('requestDirectory.run', () => {
  it('refuses when nobody was asked', async () => {
    await expect(
      requestDirectory.run({ path: '/x', reason: 'r' }, { roots: [], signal: new AbortController().signal })
    ).rejects.toThrow(/could not be asked/);
  });

  it('reports a decline as a refusal the model must not retry this turn', async () => {
    const declined = requestDirectory.run(
      { path: '/x', reason: 'r', outcome: { status: 'declined' } },
      { roots: [], signal: new AbortController().signal }
    );
    await expect(declined).rejects.toMatchObject({ name: 'PathAccessDenied' });
    await expect(declined).rejects.toThrow(/Do not ask for it again/);
  });
});
