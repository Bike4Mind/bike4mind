import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileRule, parseRule, PermissionRuleSet, type CompiledRule } from '../permissions/rules';
import { permissionSubject } from '../permissions/subject';
import { runsCheckedInAuto } from './shellApproval.testHelper';
import { shellApproval } from './shellTools';
import * as sessionScripts from './sessionScripts';
import type { ApprovalPrompt, ToolContext } from './types';

vi.mock('./userPath', async importOriginal => ({
  ...(await importOriginal<typeof import('./userPath')>()),
  resolveUserPath: vi.fn(async () => process.env.PATH ?? ''),
}));

function rules(allow: readonly string[], deny: readonly string[] = []): PermissionRuleSet {
  const compiled: CompiledRule[] = [];
  for (const [list, texts] of [
    ['allow', allow],
    ['deny', deny],
  ] as const) {
    for (const text of texts) {
      const parsed = parseRule(text);
      if (!parsed.ok) throw new Error(parsed.reason);
      const rule = compileRule(parsed.rule, list, { id: 't', label: 't' }, { home: '/nowhere', root: null, cwd: null });
      if (rule) compiled.push(rule);
    }
  }
  return new PermissionRuleSet(compiled);
}

/** Each sub-command is decided on its own unless what makes the script ask holds for all of it. */
describe('shellApproval per part', () => {
  let project: string;
  let context: ToolContext;

  beforeAll(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'b4m-parts-shell-')));
    await mkdir(join(project, 'src'));
    await writeFile(join(project, 'a'), 'a');
    context = { roots: [project], workingDirectory: project } as unknown as ToolContext;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(() => rm(project, { recursive: true, force: true }));

  const approve = (command: string, extra: Partial<ToolContext> = {}): Promise<ApprovalPrompt> =>
    shellApproval('bash_execute', { command }, { ...context, ...extra });

  const parts = (prompt: ApprovalPrompt) =>
    (prompt.always?.commands ?? []).map(({ text, coverable, ask }) => ({ text, coverable, kinds: ask?.kinds ?? [] }));

  it('marks the sending part of a chain, which auto mode runs over a clean reply, leaving the other coverable', async () => {
    const prompt = await approve('git status && node -e 1');
    expect(prompt.byPart).toBe(true);
    expect(prompt.askInAuto).toBeUndefined();
    expect(prompt.contained).toBeUndefined();
    expect(parts(prompt)).toEqual([
      { text: 'git status', coverable: true, kinds: [] },
      expect.objectContaining({ kinds: ['outbound'] }),
    ]);
  });

  it('marks only the part whose operand it cannot read, which auto and full mode still run', async () => {
    const prompt = await approve('git status && rm "$TARGET"');
    expect(prompt.byPart).toBe(true);
    expect(prompt.askInAuto).toBeUndefined();
    expect(prompt.askInFull).toBeUndefined();
    expect(prompt.unchecked).toBe(true);
    expect(parts(prompt)).toEqual([
      { text: 'git status', coverable: true, kinds: [] },
      expect.objectContaining({ coverable: false, kinds: ['unread'] }),
    ]);
  });

  it('reads the commands inside a substitution as parts of their own', async () => {
    const command = 'git status && git diff $(git merge-base origin/main HEAD)..HEAD';
    const prompt = await approve(command);
    expect(prompt.askInAuto).toBeUndefined();
    expect(prompt.always?.commands.map(({ pattern, coverable }) => [pattern, coverable])).toEqual([
      ['git status *', true],
      ['git merge-base *', true],
      ['git diff *', true],
    ]);
    const subject = permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context);
    const covered = rules(['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git merge-base:*)']).shellParts(subject);
    expect(covered?.every(rule => rule !== null)).toBe(true);
  });

  it('names an .env read as the ask of the part that reads it', async () => {
    await writeFile(join(project, '.env'), 'X=1');
    const prompt = await approve('git status && cat .env');
    expect(prompt.byPart).toBe(true);
    expect(prompt.askInAuto).toBe(true);
    expect(parts(prompt)).toEqual([
      { text: 'git status', coverable: true, kinds: [] },
      expect.objectContaining({ kinds: ['env'] }),
    ]);
  });

  it('keeps a substitution in program position opaque to the part that runs it', async () => {
    const prompt = await approve('git status && $(which node) -v');
    expect(parts(prompt)[0]).toEqual({ text: 'git status', coverable: true, kinds: [] });
    expect(parts(prompt).at(-1)).toEqual(expect.objectContaining({ coverable: false, kinds: ['unread'] }));
  });

  it.each([
    ['a script written during this session', 'git status && node generated.js', true],
    ['a failed check for session-written scripts', 'git status && printf ok', false],
  ])('decides %s as a whole, never contained, which auto mode still runs', async (_, command, written) => {
    const check = vi.spyOn(sessionScripts, 'sessionScriptRun');
    if (written) check.mockResolvedValueOnce({ names: ['generated.js'], hooks: [], untracked: false, generation: '1' });
    else check.mockRejectedValueOnce(new Error('cannot inspect scripts'));
    const prompt = await approve(command, { sessionId: 'written-script' });
    expect(prompt.byPart).toBeUndefined();
    expect(prompt.contained).toBeUndefined();
    expect(runsCheckedInAuto(prompt)).toBe(true);
  });

  describe('floors that hold for the whole script', () => {
    const whole = (prompt: ApprovalPrompt) => {
      expect(prompt.byPart).toBeUndefined();
      expect(runsCheckedInAuto(prompt)).toBe(false);
      expect(prompt.always?.commands.every(command => command.ask === undefined)).toBe(true);
    };

    it('a word bash joins across a backslash-newline the parser splits', async () => {
      const prompt = await approve('git status && echo a\\\nb');
      whole(prompt);
      expect(prompt.always?.commands.every(command => !command.coverable)).toBe(true);
    });

    it('a cd that CDPATH may redirect before a part it cannot read', async () => {
      vi.stubEnv('CDPATH', undefined);
      expect((await approve('cd src && rm "$TARGET" && git status')).byPart).toBe(true);
      vi.stubEnv('CDPATH', '/elsewhere');
      whole(await approve('cd src && rm "$TARGET" && git status'));
    });

    it('a part that runs after a directory change the scan lost', async () => {
      whole(await approve('cd "$SOMEWHERE" && git status'));
    });

    it('a part that reaches a protected settings file', async () => {
      const prompt = await approve('git status && cp a .claude/settings.json');
      whole(prompt);
      expect(prompt.askInFull).toBe(true);
    });

    it('a write while a protected folder is unresolved', async () => {
      whole(await approve('git status && touch b', { unresolvedProtectedPaths: ['/unresolved'] }));
    });

    it('an export that every later part inherits', async () => {
      whole(await approve("export GIT_SSH_COMMAND='sh -c x'; git push origin HEAD"));
      whole(await approve('GIT_SSH_COMMAND=x; git push origin HEAD'));
      whole(await approve('for HOME in .; do git status; done; git push origin HEAD'));
    });

    it('a git setting that makes git run a program', async () => {
      whole(await approve('git config core.fsmonitor ./x && git status'));
    });

    it('a WSL command whose distribution is not shared', async () => {
      const prompt = await approve('git status && wsl.exe -e cat notes.txt');
      whole(prompt);
      expect(prompt.always?.ungranted?.length).toBeGreaterThan(0);
    });

    it('a clone from another computer', async () => {
      whole(await approve('git clone https://example.com/r.git && git status'));
    });

    it('a part that reads a secret store', async () => {
      const prompt = await approve('git status && cat ~/.ssh/id_rsa');
      whole(prompt);
      expect(prompt.askInFull).toBe(true);
    });

    it('an .env file read by a redirect no part owns', async () => {
      await writeFile(join(project, '.env'), 'X=1');
      whole(await approve('git status && wc -l < .env'));
    });
  });

  describe('rule coverage per part', () => {
    const subjectOf = async (command: string) => {
      const prompt = await approve(command);
      return permissionSubject({ name: 'bash_execute', input: { command } }, prompt, context);
    };

    it('names the rule covering each part, and null for the rest', async () => {
      const covered = rules(['Bash(git status:*)']).shellParts(await subjectOf('git status && printf x'));
      expect(covered?.map(rule => rule?.text ?? null)).toEqual(['Bash(git status:*)', null]);
    });

    it('covers no part of an irreversible call', async () => {
      const subject = await subjectOf('git status && printf x');
      expect(rules(['Bash(git status:*)']).shellParts({ ...subject, irreversible: true })).toBeNull();
    });

    it('covers no part when a deny rule names any of them', async () => {
      expect(
        rules(['Bash(git status:*)'], ['Bash(printf:*)']).shellParts(await subjectOf('git status && printf x'))
      ).toBeNull();
    });

    it('covers no part of a script that names a permission file', async () => {
      const subject = await subjectOf('git status && cat .claude/settings.json');
      expect(rules(['Bash(git status:*)', 'Bash(cat:*)']).shellParts(subject)).toBeNull();
    });
  });
});
