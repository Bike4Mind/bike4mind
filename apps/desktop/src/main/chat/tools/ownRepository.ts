import { execFile } from 'node:child_process';
import { hostGitArgs } from '../../git/hostGitArgs';
import { parseRemoteLocation, type RemoteLocation, type RepositoryName } from '../../fleet/repository';

/**
 * What a `git push` or a `gh` write names as its target, read off the command's words alone.
 * `writesOwnRepository` then asks git whether that target is the folder's own `origin`.
 */
export type RepositoryWrite =
  | { kind: 'push'; cwd: string; remote?: string; destinations: string[]; force: boolean }
  /** `repository` is unset when gh picks the repository from the folder's remotes. */
  | { kind: 'github'; cwd: string; repository?: RepositoryName };

/** Runs `git -C cwd ...args` and returns trimmed stdout, or null on any failure. */
export type GitReader = (cwd: string, args: readonly string[]) => Promise<string | null>;

// Options that neither change where a push goes nor what it overwrites. Anything else (`--mirror`,
// `--all`, `--prune`, `--delete`, `--repo`, `--receive-pack`, push options) is not judged here.
const PUSH_OPTIONS = new Set([
  '-u',
  '--set-upstream',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '-n',
  '--dry-run',
  '--tags',
  '--follow-tags',
  '--no-verify',
  '--verify',
  '--atomic',
  '--porcelain',
  '--progress',
  '--no-progress',
]);
const FORCE_OPTION = /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/;
const SHORT_PUSH_CLUSTER = /^-[fuqvn]+$/;
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]*$/;

// `gh api` options whose value is the next word (or the rest of a short cluster), so it is not read as the path.
const GH_API_LONG_VALUE_OPTIONS = new Set([
  '--method',
  '--raw-field',
  '--field',
  '--header',
  '--input',
  '--jq',
  '--template',
  '--cache',
  '--preview',
]);
const GH_API_SHORT_VALUE_LETTERS = 'XfFHqtp';

// The only `gh api` writes that run unasked: the REST equivalents of `gh pr|issue create|comment|edit`.
const GH_API_OWN_WRITES: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^issues$/ },
  { method: 'POST', path: /^issues\/\d+\/comments$/ },
  { method: 'POST', path: /^pulls$/ },
  { method: 'POST', path: /^pulls\/\d+\/comments$/ },
  { method: 'PATCH', path: /^(issues|pulls)\/\d+$/ },
];

function optionValues(args: readonly string[], flags: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    for (const flag of flags) {
      if (args[i] === flag && i + 1 < args.length) values.push(args[i + 1]);
      else if (flag.startsWith('--') && args[i].startsWith(`${flag}=`)) values.push(args[i].slice(flag.length + 1));
    }
  }
  return values;
}

function parseRepository(text: string): RepositoryName | null {
  const parts = text.replace(/^github\.com\//i, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
}

function sameRepository(a: RepositoryName, b: RepositoryName): boolean {
  return a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();
}

function pushWrite(args: readonly string[], cwd: string): RepositoryWrite | null {
  let force = false;
  const positionals: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (optionsEnded || !arg.startsWith('-')) positionals.push(arg);
    else if (arg === '--') optionsEnded = true;
    else if (FORCE_OPTION.test(arg)) force = true;
    else if (SHORT_PUSH_CLUSTER.test(arg)) force ||= arg.includes('f');
    else if (!PUSH_OPTIONS.has(arg)) return null;
  }
  const [remote, ...refspecs] = positionals;
  // A URL or a path is not a configured remote of this repository.
  if (remote !== undefined && !REMOTE_NAME.test(remote)) return null;
  const destinations: string[] = [];
  for (const refspec of refspecs) {
    const spec = refspec.startsWith('+') ? refspec.slice(1) : refspec;
    if (spec !== refspec) force = true;
    const colon = spec.indexOf(':');
    // `:branch` deletes the remote branch.
    if (colon === 0) return null;
    const destination = colon > 0 ? spec.slice(colon + 1) : spec;
    destinations.push(destination === 'HEAD' ? '' : destination.replace(/^refs\/heads\//, ''));
  }
  return { kind: 'push', cwd, ...(remote ? { remote } : {}), destinations, force };
}

function githubWrite(args: readonly string[], cwd: string): RepositoryWrite | null {
  if (args.some(arg => /^--hostname(=|$)/.test(arg))) return null;
  const [sub] = args;
  if (sub === 'api') return apiWrite(args.slice(1), cwd);
  if (sub !== 'pr' && sub !== 'issue') return null;
  // A glued or clustered short flag (`-Rowner/repo`, `-R=owner/repo`, `-Fnotes.md`) is not read here.
  if (args.some(arg => /^-[A-Za-z]./.test(arg))) return null;

  const named: RepositoryName[] = [];
  for (const value of optionValues(args, ['-R', '--repo'])) {
    if (value.split('/').length > 2 && !/^github\.com\//i.test(value)) return null;
    const repository = parseRepository(value);
    if (!repository) return null;
    named.push(repository);
  }
  // A pull request or issue named by URL decides the repository however `-R` reads.
  for (const arg of args) {
    if (!/^[a-z][a-z+.-]*:\/\//i.test(arg)) continue;
    const url = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)(?:[/?#]|$)/i.exec(arg);
    if (!url) return null;
    named.push({ owner: url[1], name: url[2] });
  }
  const [first] = named;
  if (first && !named.every(repository => sameRepository(repository, first))) return null;
  return { kind: 'github', cwd, ...(first ? { repository: first } : {}) };
}

function apiWrite(args: readonly string[], cwd: string): RepositoryWrite | null {
  let path: string | undefined;
  let method: string | undefined;
  let hasBody = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.split(/=(.*)/s);
      if (!GH_API_LONG_VALUE_OPTIONS.has(name)) continue;
      const value = inline ?? args[++i];
      if (name === '--method') method = value;
      else if (name === '--field' || name === '--raw-field' || name === '--input') hasBody = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      const cluster = arg.slice(1);
      // `-F` reads files, so only the bare flag is parsed; clusters and glued values ask.
      if (cluster.includes('F') && cluster !== 'F') return null;
      const at = [...cluster].findIndex(letter => GH_API_SHORT_VALUE_LETTERS.includes(letter));
      if (at < 0) continue;
      const value = cluster.slice(at + 1) || args[++i];
      if (cluster[at] === 'X') method = value;
      else if (cluster[at] === 'f' || cluster[at] === 'F') hasBody = true;
    } else if (path === undefined) path = arg;
    else return null;
  }
  if (path === undefined) return null;
  const match = /^\/?repos\/([^/?#]+)\/([^/?#]+)(?:\/([^?#]*))?(?:[?#]|$)/.exec(path);
  if (!match) return null;
  const [, owner, name, rest = ''] = match;
  const verb = (method ?? (hasBody ? 'POST' : 'GET')).toUpperCase();
  if (!GH_API_OWN_WRITES.some(write => write.method === verb && write.path.test(rest))) return null;
  // gh fills `{owner}/{repo}` from the folder's remotes, as it picks one for `gh pr`.
  if (owner === '{owner}' && name === '{repo}') return { kind: 'github', cwd };
  if (owner.includes('{') || name.includes('{')) return null;
  return { kind: 'github', cwd, repository: { owner, name } };
}

/**
 * The repository an unquoted `git push ...` or `gh pr|issue|api ...` writes to, or null when the
 * words alone cannot pin it to a configured remote: a URL or path remote, a global git option
 * (`-C`, `-c`, `--git-dir`), a push option that is not on the list, a branch deletion, another
 * host, a GraphQL call, or any other program. Pure; the caller rules out env and computed words.
 */
export function repositoryWrite(tokens: readonly string[], cwd: string): RepositoryWrite | null {
  const [program, ...args] = tokens;
  if (program === 'git') return args[0] === 'push' ? pushWrite(args.slice(1), cwd) : null;
  if (program === 'gh') return githubWrite(args, cwd);
  return null;
}

/**
 * Files a gh call reads and sends: a `--body-file`, an API `--input`, or an `@file` field. The
 * scan checks them like any path argument, so a body read from outside the project still asks.
 */
export function ghReadFiles(tokens: readonly string[]): string[] {
  const [program, sub, ...args] = tokens;
  if (program !== 'gh') return [];
  const files =
    sub === 'api'
      ? [
          ...optionValues(args, ['--input']),
          ...optionValues(args, ['-F', '--field'])
            .map(field => field.slice(field.indexOf('=') + 1))
            .filter(value => value.startsWith('@'))
            .map(value => value.slice(1)),
        ]
      : optionValues(args, ['-F', '--body-file']);
  return files.filter(file => file && file !== '-');
}

const runGit: GitReader = (cwd, args) =>
  new Promise(resolve => {
    execFile('git', hostGitArgs(['-C', cwd, ...args]), { timeout: 2000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });

async function remoteLocation(git: GitReader, cwd: string, remote: string): Promise<RemoteLocation | null> {
  const url = await git(cwd, ['remote', 'get-url', '--push', remote]);
  return url ? parseRemoteLocation(url) : null;
}

function sameLocation(a: RemoteLocation, b: RemoteLocation): boolean {
  return a.host === b.host && a.path === b.path && sameRepository(a, b);
}

async function pushesToOrigin(
  write: Extract<RepositoryWrite, { kind: 'push' }>,
  origin: RemoteLocation,
  git: GitReader
): Promise<boolean> {
  const { cwd } = write;
  let remote = write.remote;
  if (!remote) {
    // `@{push}` is where a bare `git push` sends the current branch, e.g. `origin/feature`.
    const target = await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']);
    const slash = target?.indexOf('/') ?? -1;
    if (target && slash > 0) {
      remote = target.slice(0, slash);
    } else {
      remote = (await git(cwd, ['config', '--get', 'remote.pushDefault'])) ?? 'origin';
    }
  }
  const location = await remoteLocation(git, cwd, remote);
  if (!location || !sameLocation(location, origin)) return false;
  if (!write.force) return true;

  const remoteHead = await git(cwd, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
  // Without a known default branch a force push cannot be shown to spare it.
  if (!remoteHead?.startsWith(`${remote}/`)) return false;
  const protectedBranches = new Set(['main', 'master', remoteHead.slice(remote.length + 1)]);
  // Only a plainly named feature branch is the agent's own to rewrite. HEAD, `@` and an empty
  // destination resolve later than the scan; globs and qualified refs (`heads/main`) can name any branch.
  return (
    write.destinations.length > 0 &&
    write.destinations.every(
      branch =>
        branch !== '' &&
        branch !== '@' &&
        !/\*|^(refs|heads|remotes|tags)\//.test(branch) &&
        !protectedBranches.has(branch)
    )
  );
}

async function githubTargetsOrigin(
  write: Extract<RepositoryWrite, { kind: 'github' }>,
  origin: RemoteLocation,
  git: GitReader
): Promise<boolean> {
  if (origin.host !== 'github.com') return false;
  if (write.repository) return sameRepository(write.repository, origin);
  if (process.env.GH_REPO) return false;
  // gh's own choice of remote: the one `gh repo set-default` marked, else the only remote there is.
  const resolved = await git(write.cwd, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']);
  const marked = resolved
    ?.split('\n')
    .map(line => /^remote\.(.+)\.gh-resolved\s+(.+)$/.exec(line.trim()))
    .find(match => match !== null);
  if (marked) {
    if (marked[2] === 'base') {
      const location = await remoteLocation(git, write.cwd, marked[1]);
      return location !== null && sameLocation(location, origin);
    }
    const repository = parseRepository(marked[2]);
    return repository !== null && sameRepository(repository, origin);
  }
  const remotes = (await git(write.cwd, ['remote']))?.split('\n').map(line => line.trim()) ?? [];
  return remotes.length === 1 && remotes[0] === 'origin';
}

/**
 * Whether a write goes to the `origin` repository of the folder it runs in: a push to a remote
 * whose URL is origin's (and, when forced, not onto the default branch), or a gh call aimed at
 * origin on github.com. Auto mode runs these unasked when the reply has read nothing untrusted.
 */
export async function writesOwnRepository(write: RepositoryWrite, git: GitReader = runGit): Promise<boolean> {
  const originUrl = await git(write.cwd, ['config', '--get', 'remote.origin.url']);
  const origin = originUrl ? parseRemoteLocation(originUrl) : null;
  if (!origin) return false;
  return write.kind === 'push' ? pushesToOrigin(write, origin, git) : githubTargetsOrigin(write, origin, git);
}
