import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { assessApprovalRisk, spendsCredits } from './riskAssessment';
import type { ApprovalPrompt, ToolContext } from './types';

const NO_PROMPT: ApprovalPrompt = { detail: '', key: 'k' };

describe('assessApprovalRisk', () => {
  let root: string;
  let context: ToolContext;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'b4m-risk-')));
    await writeFile(join(root, 'notes.txt'), 'hello\n', 'utf8');
    await mkdir(join(root, 'sub'));
    // Inside the root by name, outside it once resolved - which is the only thing a `cd` check
    // that stopped at the lexical path would miss.
    await symlink(tmpdir(), join(root, 'escape'));
    // A link from the root back to the root. Harmless to follow, and the one shape that makes a
    // `..` after it leave: `self/..` is the root's PARENT to the kernel and the root itself to
    // `path.resolve`.
    await symlink(root, join(root, 'self'));
    context = { roots: [root], workingDirectory: root, signal: new AbortController().signal };
  });

  const shell = (command: string, input: Record<string, unknown> = {}) =>
    assessApprovalRisk('bash_execute', { command, ...input }, NO_PROMPT, context);

  const write = (path: string) =>
    assessApprovalRisk(
      'file_write',
      { path, content: 'x' },
      { detail: '', key: 'k', diff: { path, operation: 'create', added: 1, removed: 0, lines: [] } },
      context
    );

  describe('shell commands that may run unattended', () => {
    it.each([
      'git status',
      'git log --oneline -20',
      'git diff HEAD',
      'ls -la',
      'cat notes.txt',
      'grep -rn todo .',
      'wc -l notes.txt',
      `cat ${join('{ROOT}', 'notes.txt')}`,
      'jq .name package.json',
      'git merge-base HEAD main',
      'git show-ref --heads',
      'git reflog',
    ])('allows %s', async command => {
      expect(await shell(command.replace('{ROOT}', root))).toBe('contained');
    });

    /**
     * The quoting that used to be refused outright. An argument the shell hands over verbatim
     * is still one fixed argv, which is all the per-token checks ever needed.
     */
    it.each([
      ['a quoted argument with a space', 'grep "foo bar" notes.txt'],
      ['a quoted glob, which the shell never expands', "find . -name '*.ts'"],
      ['a single-quoted argument', "grep 'foo bar' notes.txt"],
    ])('allows %s', async (_label, command) => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * A pipeline of inert commands is still inert: nothing on the allow-list writes to a file,
     * so no chain of them can, and a redirect is rejected while tokenizing.
     */
    it.each(['cat notes.txt | head -50', 'git log --oneline | head -20', 'grep -rn todo . | sort | uniq -c'])(
      'allows %s',
      async command => {
        expect(await shell(command)).toBe('contained');
      }
    );

    /** Bare and listing forms read; the block below holds the forms that do not. */
    it.each(['git branch', 'git branch -a', 'git branch --list'])('allows %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * An `&&` chain of reads is a read. The steps are separate commands rather than separate
     * segments of one pipeline, which matters only for where a `cd` lands; nothing else about
     * the argument for a pipeline changes.
     */
    it.each([
      'git status --short && git log --oneline',
      'cat notes.txt && wc -l notes.txt && ls',
      'git log --oneline | head -20 && git status --short',
      'cd {ROOT} && git status',
      'cd {ROOT}/sub && git status',
      // The case this was opened for, which asked twice over: once for the `&&` and once for
      // the `cd`.
      'cd {ROOT} && git log --oneline origin/main..HEAD | head -50 && echo "---STATUS---" && git status --short',
    ])('allows %s', async command => {
      expect(await shell(command.replace('{ROOT}', root))).toBe('contained');
    });

    /**
     * The point of threading the directory rather than merely allowing `cd`: `../notes.txt` is
     * inside the root from `sub` and outside it from the root itself, so the pair below can
     * only both hold if the second step was assessed where it will actually run.
     */
    it('resolves a later step against the directory an earlier cd moved to', async () => {
      expect(await shell(`cd ${join(root, 'sub')} && cat ../notes.txt`)).toBe('contained');
      expect(await shell('cat ../notes.txt')).toBe('sensitive');
    });
  });

  /**
   * `..` is where a lexical answer and the kernel's part company, and a granted root holding a
   * link back to itself is all it takes: the kernel applies `..` to whatever the symlinks
   * before it resolved to, `path.resolve` applies it to the name on its left.
   */
  describe('a dot-dot that follows a symlink', () => {
    it.each([
      ['a link to the root, then out of it', 'cat self/../notes.txt'],
      ['the same written absolute', 'cat {ROOT}/self/../notes.txt'],
      ['two links deep', 'cat self/self/../../notes.txt'],
      ['a cd through the link, then out of it', 'cd {ROOT}/self && cat ../notes.txt'],
      ['a cd through the link, then out by an absolute path', 'cd {ROOT}/self && cat {ROOT}/self/../notes.txt'],
      ['a grep rooted past the link', 'grep -rn todo self/..'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command.split('{ROOT}').join(root))).toBe('sensitive');
    });

    /** The ordinary shapes the check above must not start refusing. */
    it.each([
      'cat sub/../notes.txt',
      'cat {ROOT}/sub/../notes.txt',
      'cd {ROOT}/sub && cat ../notes.txt',
      'cd {ROOT}/self && cat notes.txt',
      'cat self/notes.txt',
    ])('still allows %s', async command => {
      expect(await shell(command.split('{ROOT}').join(root))).toBe('contained');
    });
  });

  /**
   * `cd` is the one allow-listed word that changes what every command after it reads, so the
   * bound on it is narrower than on anything else: one argument, absolute, and inside a root
   * once its symlinks are resolved.
   */
  describe('the directory a chain runs in', () => {
    it.each([
      ['no argument at all, which is $HOME', 'cd && git status'],
      ['the previous directory, which cannot be known from the text', 'cd - && git status'],
      ['a second argument', 'cd {ROOT} {ROOT}/sub && git status'],
      ['a flag that changes how the symlinks resolve', 'cd -P {ROOT} && git status'],
      ['a relative name, which bash may look up through CDPATH', 'cd sub && git status'],
      ['a directory outside every granted root', 'cd /etc && git status'],
      ['a symlink out of the root', 'cd {ROOT}/escape && git status'],
      // Every segment of a pipeline is a subshell, so this one moves nothing and `..` is still
      // being resolved from the root.
      ['a cd piped, which leaves the directory where it was', 'cd {ROOT}/sub | cat ../notes.txt'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command.split('{ROOT}').join(root))).toBe('sensitive');
    });
  });

  /**
   * Commands that read in their bare form and write once given an argument. Each of these is on
   * the allow-list, so the only thing standing between them and the disk is the bound here.
   */
  describe('allowed commands that write when given the right argument', () => {
    it.each([
      ['sort writing its output to a file', 'sort -o out.txt notes.txt'],
      ['sort spelling the same flag out', 'sort --output=out.txt notes.txt'],
      ['git diff writing a patch to a file', 'git diff --output=x.txt'],
      ['git diff with the flag spaced', 'git diff --output x.txt'],
      ['creating a branch', 'git branch foo'],
      ['deleting a branch', 'git branch -D foo'],
      ['renaming a branch', 'git branch -m old new'],
      ['retargeting a branch', 'git branch --set-upstream-to=origin/main'],
      ['dropping reflog entries', 'git reflog expire --all'],
      ['xxd writing its second path argument', 'xxd notes.txt out.bin'],
      ['uniq writing its second path argument', 'uniq notes.txt out.txt'],
      ['find writing its list to a file', 'find . -name x -fprint0 out.txt'],
      ['tree writing its listing to a file', 'tree -o out.txt'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  /**
   * The worst case for an allow-list of read-only commands: an entry on it that will run
   * something else for you. Each of these was verified to execute, not merely suspected.
   */
  describe('allowed commands that run another program when asked the right way', () => {
    it.each([
      // `-O<cmd>` glues its value to the letter, so there is no `=` and no separate token.
      ['git grep opening its hits in a pager it was handed', "git grep -O'touch PWNED' pattern"],
      ['the same, spelled long', "git grep --open-files-in-pager='touch PWNED' pattern"],
      ['the bare form, which runs whatever the config says', 'git grep -O pattern'],
      // Everything before the subcommand is git's own, and several of those name a program.
      ['a config override naming an external diff', "git -c diff.external='touch PWNED' diff"],
      ['a config override naming a pager', "git -p -c core.pager='touch PWNED' log"],
      ['an exec-path override', 'git --exec-path=/tmp/evil status'],
      ['sort compressing its temp files with a program', "sort --compress-program='touch PWNED' notes.txt"],
      ['git help opening a browser', 'git help -w status'],
      // These choose WHICH repository runs, and so which config names the program git runs.
      // A bare relative name is the case the path check never saw: it reads as naming no path.
      ['a repository chosen by relative name', 'git --git-dir=alt status'],
      ['the same, spaced', 'git --git-dir alt status'],
      ['a repository chosen by absolute path', 'git --git-dir=/tmp/evil/.git log'],
      ['a working tree pointed elsewhere', 'git --work-tree=/tmp status'],
      ['both at once, which is the working exploit', 'git --git-dir=alt --work-tree=. status'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });

    /** The globals that name no program stay allowed, so the usual spellings do not regress. */
    it.each(['git --no-pager log --oneline', 'git --no-optional-locks status', 'git help status'])(
      'still allows %s',
      async command => {
        expect(await shell(command)).toBe('contained');
      }
    );
  });

  /**
   * The scripts the user decided are worth not being asked about. These are not inert - they
   * run whatever the repository's package.json puts behind the name - so the bound being
   * asserted here is the NAME, and the block below is the other half of that bound.
   */
  describe('package-manager scripts the user chose to allow', () => {
    it.each([
      'yarn test',
      'npm test',
      'pnpm test',
      'pnpm lint:check',
      'npm run lint',
      'pnpm run typecheck',
      'pnpm test:unit',
      'yarn typecheck:all',
      // The keyword in a later segment, which is how this repository's own commands are spelled
      // and which an anchored pattern asked about every time.
      'pnpm turbo:test',
      'pnpm turbo:typecheck',
      'pnpm lint:check',
    ])('allows %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * The workspace form the user actually types. The filter VALUE sits where the script name
     * would otherwise be read from, which is the whole reason the flag has to be known about.
     */
    it.each([
      'pnpm --filter @bike4mind/client test',
      'pnpm --filter=@bike4mind/client test',
      'pnpm -C packages/api lint',
      'pnpm --filter @bike4mind/desktop typecheck',
    ])('reads the script past a value-taking flag in %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    /**
     * The flag's value is still a path argument like any other, so pointing it out of the
     * granted roots asks even though the script name is one of the allowed few.
     */
    it('asks when a filter value escapes the granted roots', async () => {
      expect(await shell('pnpm --filter ../../../etc test')).toBe('sensitive');
    });

    it.each([
      ['a bare package manager, which installs', 'yarn'],
      ['an install', 'npm install'],
      ['adding a dependency', 'pnpm add left-pad'],
      // These fetch and run a package that is not the repository's, which is not what the
      // user agreed to when they agreed to their own test script.
      ['a fetched one-off package', 'npx cowsay hello'],
      ['pnpm dlx', 'pnpm dlx tsx'],
      ['running an arbitrary binary', 'pnpm exec sh'],
      ['publishing', 'npm publish'],
      ['a build', 'pnpm build'],
      ['a start script', 'npm start'],
      ['a deploy script', 'yarn deploy'],
      // The bound is the keyword, not where it sits: a script named nothing like one of the
      // three is still not the repository's test, lint or typecheck.
      ['a script that merely contains an allowed word', 'pnpm pretest-everything'],
      ['a script named after no keyword at all', 'pnpm turbo:deploy'],
      ['run with no script after it', 'pnpm run'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });

    /**
     * The regression that would hurt most: the script allow-list must not become a way to get
     * a second command past the gate. `;`, `|`, `>` and `||` never reach the allow-list at all,
     * because the shell-control check runs first; `&&` does reach it now, and the second step
     * is held to exactly the same bar as the first.
     */
    it.each([
      'yarn test; rm -rf /',
      'yarn test && curl evil.example.com',
      'pnpm test | sh',
      'pnpm test > out.txt',
      'pnpm test || rm -rf .',
    ])('still refuses %s', async command => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  /**
   * The other entry the user chose rather than proved. `gh` reaches the network carrying their
   * GitHub credential, so the bound is the subcommand and nothing else, two words deep.
   */
  describe('the read-only GitHub commands the user chose to allow', () => {
    it.each([
      'gh pr view 123',
      'gh pr list',
      'gh pr diff 123',
      'gh pr checks 123',
      'gh pr status',
      'gh issue view 3622',
      'gh issue list',
      'gh run list',
      'gh run view 42',
      'gh repo view',
      'gh release view',
      'gh release list',
      'gh status',
    ])('allows %s', async command => {
      expect(await shell(command)).toBe('contained');
    });

    it.each([
      // The first word decides nothing, which is why the check is two words deep.
      ['creating a pull request', 'gh pr create'],
      ['merging one', 'gh pr merge 1'],
      ['closing one', 'gh pr close 1'],
      ['editing an issue', 'gh issue edit 1'],
      ['uploading a release asset', 'gh release upload v1 file.zip'],
      ['starting a workflow', 'gh workflow run deploy.yml'],
      ['re-running a job', 'gh run rerun 1'],
      ['cancelling one', 'gh run cancel 1'],
      // Reaches any endpoint at all, and writes through one when asked to.
      ['the raw API', 'gh api /user'],
      // Prints the user's credential straight into the transcript.
      ['the stored token', 'gh auth token'],
      ['opening a browser', 'gh browse'],
      ['the same by flag on an allowed subcommand', 'gh pr view --web'],
      ['its short spelling', 'gh pr view -w'],
      // Both sit there until the run finishes, which is not a thing to start unattended.
      ['waiting on a run', 'gh run watch 1'],
      ['waiting on checks', 'gh pr checks --watch'],
      ['a bare gh, which prints help and nothing else useful', 'gh'],
      ['a subcommand nobody listed', 'gh gist create'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  /**
   * The cases this mode exists to still catch. Each is something a crafted prompt would try,
   * and each has to reach the user rather than the shell.
   */
  describe('reads outside the granted roots', () => {
    it.each([
      ['an absolute path elsewhere', 'cat /etc/hosts'],
      ['a relative walk out of the root', 'cat ../../../etc/hosts'],
      ['a home-relative path', 'cat ~/.ssh/id_rsa'],
      ['a path hidden in a --flag=value', 'git --git-dir=/tmp/other/.git log'],
      ['a cwd outside every root', 'ls'],
      // Quoting no longer refuses a command by itself, so the path inside it has to.
      ['a quoted absolute path elsewhere', 'cat "/etc/hosts"'],
      ['a quoted walk out of the root', "cat '../../../etc/passwd'"],
      ['an unquoted walk out of the root', 'cat ../../../etc/passwd'],
    ])('asks for %s', async (_label, command) => {
      const scoped = command === 'ls' ? shell(command, { cwd: '/etc' }) : shell(command);
      expect(await scoped).toBe('sensitive');
    });
  });

  describe('commands whose effect cannot be read off the text', () => {
    it.each([
      ['a command substitution', 'echo $(cat /etc/passwd)'],
      ['a substitution inside double quotes, which still expands', 'echo "$(whoami)"'],
      ['a backtick substitution inside double quotes', 'echo "`whoami`"'],
      ['an escape inside double quotes', 'echo "a\\tb"'],
      ['an unterminated quote', "cat 'unterminated"],
      ['a chain whose second step is not on the list', 'git status && rm -rf .'],
      ['a chain whose second step reaches the network', 'cat notes.txt && curl https://example.com'],
      // One character from the separator, and none of them is it.
      ['a backgrounded first command', 'git status & cat notes.txt'],
      ['a redirect of both streams, which is not a separator', 'git status &> out.txt'],
      ['a redirect of both streams onto a descriptor', 'git status &>& 1'],
      ['three ampersands', 'git status &&& cat notes.txt'],
      ['a leading chain separator', '&& git status'],
      ['a trailing chain separator', 'git status &&'],
      ['a doubled chain separator', 'git status && && ls'],
      ['a semicolon', 'cat notes.txt; rm -rf .'],
      ['an or-chain, which is not a pipe', 'cat a.txt || rm b.txt'],
      ['a leading pipe', '| cat notes.txt'],
      ['a trailing pipe', 'cat notes.txt |'],
      ['a redirect', 'cat notes.txt > /tmp/leak'],
      ['a redirect to a relative file', 'cat notes.txt > out.txt'],
      ['a backgrounded command', 'git status &'],
      ['a newline', 'git status\ncat /etc/hosts'],
      // The shell expands these into names this module never checked, one of which could be a
      // symlink pointing out of the granted root.
      ['a glob', 'cat *.txt'],
      ['a single-character glob', 'cat note?.txt'],
      ['a flag that follows symlinks while walking', 'grep -R secret .'],
      ['ls following a symlink', 'ls -L .'],
      ['find following symlinks', 'find -L . -name x'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  describe('executables that are not inert', () => {
    it.each([
      ['a package manager installing', 'pnpm install'],
      ['an interpreter', 'node index.js'],
      ['a network client', 'curl https://example.com'],
      ['a deletion', 'rm -rf build'],
      ['a permission change', 'chmod +x script.sh'],
      ['a path-named executable', './configure'],
      ['an env wrapper', '/usr/bin/env sh'],
      ['a git subcommand that reaches the network', 'git push origin main'],
      ['a git subcommand that changes the working tree', 'git checkout main'],
      ['a git subcommand that reads config outside the repo', 'git config --get user.email'],
      ['find running a program', 'find . -name x -exec cat {} ;'],
      ['ripgrep running a preprocessor', 'rg --pre /tmp/leak pattern'],
      // A pipeline is only as contained as its least contained segment.
      ['a pipeline into a shell', 'cat notes.txt | sh'],
      ['a pipeline into a writer', 'cat notes.txt | tee out.txt'],
      ['a stream editor that can write in place', 'sed -i s/a/b/ notes.txt'],
      ['an env wrapper around anything at all', 'env FOO=1 rm -rf .'],
      ['an interactive pager', 'less notes.txt'],
      // Inert by the filesystem bar, and asked about anyway: what they print is every secret
      // the app was started with, and other processes' command lines, tokens and all.
      ['the environment', 'printenv'],
      ['one environment variable', 'printenv AWS_SECRET_ACCESS_KEY'],
      ['other processes and their arguments', 'ps aux'],
      ['the same inside a pipeline', 'printenv | grep -i token'],
    ])('asks for %s', async (_label, command) => {
      expect(await shell(command)).toBe('sensitive');
    });
  });

  describe('writes', () => {
    it('allows an ordinary file inside a granted root', async () => {
      expect(await write(join(root, 'src', 'index.ts'))).toBe('contained');
    });

    it.each([
      ['a git hook', '.git/hooks/pre-commit'],
      // `git status` is on the allow-list, and this file is where `core.fsmonitor` names what
      // it runs. The gitfile reaches a config elsewhere the same way.
      ['the repository config', '.git/config'],
      ['anything else in the git directory', '.git/HEAD'],
      ['a gitfile standing in for the directory', 'sub/.git'],
      ['a CI workflow', '.github/workflows/ci.yml'],
      ['a shell rc file', '.zshrc'],
      ['a direnv file', '.envrc'],
      ['a package registry config', '.npmrc'],
      ['a launch agent', 'Library/LaunchAgents/com.example.plist'],
    ])('asks for %s, which something else executes later', async (_label, relative) => {
      expect(await write(join(root, relative))).toBe('sensitive');
    });

    /**
     * macOS and Windows open `.GIT/config` as `.git/config`, so a pattern matched only in lower
     * case guards nothing on either of the two platforms this app ships to.
     */
    it.each([
      ['the git directory shouted', '.GIT/config'],
      ['a git hook in mixed case', '.Git/hooks/pre-commit'],
      ['a launch agent in lower case', 'library/launchagents/com.example.plist'],
      ['a shell rc in upper case', '.ZSHRC'],
    ])('asks for %s', async (_label, relative) => {
      expect(await write(join(root, relative))).toBe('sensitive');
    });

    /**
     * The path comes from `resolve`, so on Windows it is spelled with `\`. Every pattern is
     * written in posix, and without normalizing they match nothing there.
     */
    it.each([
      ['a git config', 'C:\\Users\\dev\\project\\.git\\config'],
      ['a git hook', 'C:\\Users\\dev\\project\\.git\\hooks\\pre-commit'],
      ['a CI workflow', 'C:\\Users\\dev\\project\\.github\\workflows\\ci.yml'],
      ['a shouted git directory', 'C:\\Users\\dev\\project\\.GIT\\config'],
    ])('asks for %s written with native Windows separators', async (_label, windowsPath) => {
      expect(await write(windowsPath)).toBe('sensitive');
    });

    it('still allows an ordinary Windows path', async () => {
      expect(await write('C:\\Users\\dev\\project\\src\\index.ts')).toBe('contained');
    });
  });

  describe('fails closed', () => {
    /**
     * The T22 case. An MCP server's tools route through the same gate, and nothing here knows
     * what one does, so 'auto' has to keep asking about them until somebody classifies them.
     */
    it('asks for a tool it has never heard of', async () => {
      expect(await assessApprovalRisk('mcp__linear__create_issue', {}, NO_PROMPT, context)).toBe('sensitive');
    });

    it('asks when there is no granted root to prove containment against', async () => {
      context = { ...context, roots: [], workingDirectory: undefined };
      expect(await shell('git status')).toBe('sensitive');
    });

    it('asks for an irreversible call whatever its name', async () => {
      const prompt: ApprovalPrompt = { detail: '', key: 'k', irreversible: true };
      expect(await assessApprovalRisk('session_archive', {}, prompt, context)).toBe('sensitive');
    });

    it('asks for a write whose resolved path the gate did not report', async () => {
      expect(await assessApprovalRisk('file_write', { path: 'x' }, NO_PROMPT, context)).toBe('sensitive');
    });
  });

  describe('apply_patch', () => {
    const diff = (path: string, operation: 'create' | 'edit' | 'delete', movedFrom?: string) => ({
      path,
      operation,
      added: 1,
      removed: 0,
      lines: [],
      ...(movedFrom ? { movedFrom } : {}),
    });
    const patch = (diffs: ReturnType<typeof diff>[]) =>
      assessApprovalRisk('apply_patch', {}, { detail: '', key: 'k', diffs }, context);

    it('is contained when every file is, and sensitive when any one is executed later', async () => {
      expect(await patch([diff('/p/a.ts', 'edit'), diff('/p/b.ts', 'create')])).toBe('contained');
      expect(await patch([diff('/p/a.ts', 'edit'), diff('/p/.github/workflows/ci.yml', 'edit')])).toBe('sensitive');
      expect(await patch([diff('/p/a.ts', 'edit', '/p/.envrc')])).toBe('sensitive');
      expect(await patch([diff('C:\\Users\\dev\\project\\.GIT\\config', 'edit')])).toBe('sensitive');
      expect(await patch([diff('C:\\Users\\dev\\project\\src\\a.ts', 'edit')])).toBe('contained');
    });

    it('always asks about a deletion, and when no diff was reported', async () => {
      expect(await patch([diff('/p/a.ts', 'delete')])).toBe('sensitive');
      expect(await assessApprovalRisk('apply_patch', {}, NO_PROMPT, context)).toBe('sensitive');
    });
  });

  /**
   * Cost is a separate axis from filesystem risk: these ask in every mode, including 'full',
   * so the classifier reports them as sensitive rather than leaving it to the caller alone.
   */
  describe('the credit-spending axis', () => {
    it.each(['generate_image', 'generate_speech', 'generate_sound_effect', 'generate_music', 'session_spawn'])(
      '%s spends credits and always asks',
      name => {
        expect(spendsCredits(name)).toBe(true);
      }
    );

    it('does not fold the shell tools into the cost axis', () => {
      expect(spendsCredits('bash_execute')).toBe(false);
      expect(spendsCredits('file_write')).toBe(false);
    });
  });
});
