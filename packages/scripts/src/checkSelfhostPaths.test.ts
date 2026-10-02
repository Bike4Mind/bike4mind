import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Every file path the self-host stack hands to a process exists in the repo.
 *
 * The compose `command` lists and the selfhost Dockerfiles' `CMD` pass tsx a tsconfig, an
 * `--import` hook and an entry file, each relative to the container's working directory. None of
 * that is typechecked or linted, so a path left behind by a file move (or a `working_dir` change)
 * stays green everywhere and only fails when the container starts.
 *
 * The images `COPY . .` into `/app`, so `/app/<x>` in the container is `<x>` in the repo. Text-
 * matched rather than YAML-parsed, like the other compose guards here: the repo has no YAML parser
 * dependency, and the shapes read below are the only ones these files use.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTAINER_ROOT = '/app';

interface PathRef {
  source: string;
  cwd: string;
  arg: string;
}

const FILE_ARG = /\.(?:[cm]?[jt]s|json)$/;
const PATH_FLAGS = new Set(['--tsconfig', '--import']);

/**
 * The arguments that name a file: anything after a path-taking flag, or ending in a file extension.
 * `--flag=value` is split first, so its value is not dropped along with the flag.
 */
const pathArgs = (argv: string[]): string[] => {
  const split = argv.flatMap(arg => /^(--[\w-]+)=(.+)$/.exec(arg)?.slice(1) ?? [arg]);
  return split.filter((arg, i) => !arg.startsWith('-') && (PATH_FLAGS.has(split[i - 1]) || FILE_ARG.test(arg)));
};

const quotedStrings = (text: string): string[] => [...text.matchAll(/'([^']*)'|"([^"]*)"/g)].map(m => m[1] ?? m[2]);

/** Maps an absolute container directory under /app to its repo-relative path. */
const toRepoDir = (containerDir: string): string => {
  const rel = path.posix.relative(CONTAINER_ROOT, containerDir);
  if (rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    throw new Error(`${containerDir} is outside ${CONTAINER_ROOT}`);
  }
  return rel;
};

/**
 * Each service's `working_dir` + flow-sequence `command` path arguments. A service without both is
 * skipped: its paths are not checked here, even if its `command` overrides the image's CMD.
 */
const composeRefs = (source: string, file: string): PathRef[] => {
  const refs: PathRef[] = [];
  const services = source.split(/^ {2}(?=[\w-]+:\s*$)/m).slice(1);
  for (const service of services) {
    const name = /^[\w-]+/.exec(service)![0];
    const workingDir = /^ {4}working_dir:\s*(\S+)\s*$/m.exec(service);
    const command = /^ {4}command:\s*(\[[\s\S]*?\])/m.exec(service);
    if (!workingDir || !command) continue;
    const cwd = toRepoDir(workingDir[1]);
    for (const arg of pathArgs(quotedStrings(command[1]))) {
      refs.push({ source: `${file} service ${name}`, cwd, arg });
    }
  }
  return refs;
};

/**
 * Each exec-form `CMD`'s path arguments, resolved against the last `WORKDIR` above it. An
 * `ENTRYPOINT` is rejected rather than parsed, so paths moved into one cannot go unchecked.
 */
const dockerfileRefs = (source: string, file: string): PathRef[] => {
  const refs: PathRef[] = [];
  let workdir: string | null = null;
  for (const line of source.split('\n')) {
    const dir = /^WORKDIR\s+(\S+)\s*$/.exec(line);
    if (dir) workdir = dir[1];
    if (/^ENTRYPOINT\b/.test(line)) throw new Error(`${file}: ENTRYPOINT is not checked by this guard`);
    const cmd = /^CMD\s+(\[.*\])\s*$/.exec(line);
    if (!cmd) continue;
    if (!workdir) throw new Error(`${file}: CMD before any WORKDIR`);
    const cwd = toRepoDir(workdir);
    for (const arg of pathArgs(JSON.parse(cmd[1]) as string[])) {
      refs.push({ source: `${file} CMD`, cwd, arg });
    }
  }
  return refs;
};

describe('self-host process paths resolve', () => {
  const composeFile = 'compose.selfhost.yaml';
  const dockerfiles = readdirSync(path.join(REPO_ROOT, 'apps/client'))
    .filter(name => /^Dockerfile\..+\.selfhost$/.test(name))
    .map(name => `apps/client/${name}`);

  const refs = [
    ...composeRefs(readFileSync(path.join(REPO_ROOT, composeFile), 'utf8'), composeFile),
    ...dockerfiles.flatMap(file => dockerfileRefs(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file)),
  ];

  // Exact counts, so a parser that stopped matching an arg fails here instead of passing
  // vacuously: the worker service's tsconfig, hook and entry, and each Dockerfile CMD's hook and
  // entry. Adding a service, or a selfhost Dockerfile whose CMD is also hook + entry, needs no edit.
  it('finds the worker service and every selfhost Dockerfile CMD', () => {
    expect(dockerfiles.length).toBeGreaterThanOrEqual(2);
    expect(refs.filter(ref => ref.source === `${composeFile} service worker`)).toHaveLength(3);
    for (const file of dockerfiles) {
      expect(
        refs.filter(ref => ref.source === `${file} CMD`),
        file
      ).toHaveLength(2);
    }
  });

  it('every path exists relative to its working directory', () => {
    const missing = refs
      .filter(ref => !existsSync(path.join(REPO_ROOT, ref.cwd, ref.arg)))
      .map(ref => `${ref.source}: ${ref.arg} (from /app/${ref.cwd})`);
    expect(missing).toEqual([]);
  });
});

describe('pathArgs', () => {
  it('keeps flag values and file-like args, drops commands and flags', () => {
    expect(
      pathArgs(['pnpm', 'exec', 'tsx', '--tsconfig', 'tsconfig.selfhost.json', '--import', './hook.mjs', 'src/main.ts'])
    ).toEqual(['tsconfig.selfhost.json', './hook.mjs', 'src/main.ts']);
  });

  it('splits --flag=value so the value is kept', () => {
    expect(pathArgs(['tsx', '--import=./hook.mjs', '--tsconfig=tsconfig.json', 'main.ts'])).toEqual([
      './hook.mjs',
      'tsconfig.json',
      'main.ts',
    ]);
  });

  it('ignores args that are neither', () => {
    expect(pathArgs(['mongod', '--replSet', 'rs0', '--bind_ip_all'])).toEqual([]);
  });
});

describe('composeRefs', () => {
  const compose = [
    'services:',
    '  worker:',
    '    working_dir: /app/apps/workers',
    '    command:',
    '      [',
    "        'tsx',",
    "        '--import',",
    "        '../client/hook.mjs',",
    "        'src/main.ts',",
    '      ]',
    '  mongo:',
    "    command: ['mongod', '--replSet', 'rs0']",
  ].join('\n');

  it('reads a multi-line command against its own working_dir, and skips services without one', () => {
    expect(composeRefs(compose, 'c.yaml')).toEqual([
      { source: 'c.yaml service worker', cwd: 'apps/workers', arg: '../client/hook.mjs' },
      { source: 'c.yaml service worker', cwd: 'apps/workers', arg: 'src/main.ts' },
    ]);
  });
});

describe('dockerfileRefs', () => {
  it('uses the last WORKDIR above the CMD', () => {
    const dockerfile = ['WORKDIR /app', 'COPY . .', 'WORKDIR /app/apps/client', 'CMD ["tsx", "server/main.ts"]'].join(
      '\n'
    );
    expect(dockerfileRefs(dockerfile, 'D')).toEqual([{ source: 'D CMD', cwd: 'apps/client', arg: 'server/main.ts' }]);
  });

  it('rejects an ENTRYPOINT', () => {
    expect(() => dockerfileRefs('WORKDIR /app\nENTRYPOINT ["tsx", "main.ts"]', 'D')).toThrow(/ENTRYPOINT/);
  });

  it('rejects a WORKDIR outside /app', () => {
    expect(() => dockerfileRefs('WORKDIR /srv\nCMD ["node", "a.js"]', 'D')).toThrow(/outside/);
  });
});
