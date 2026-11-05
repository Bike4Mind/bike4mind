import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BackgroundProcessInfo } from '@shared/chat';
import type { BackgroundProcessRegistry } from '../tools/BackgroundProcessRegistry';
import type { WorkspaceOutcome } from './workspace';

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';

export interface InstallPlan {
  manager: PackageManager;
  command: string;
}

/** How long a finished install keeps announcing itself, so the prompt settles back afterwards. */
const DONE_NOTE_MS = 10 * 60_000;
const FAILURE_TAIL_CHARS = 1_500;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(directory: string): Promise<{ packageManager?: unknown } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function declaredManager(field: unknown): { manager: PackageManager; major: number | null } | null {
  if (typeof field !== 'string') return null;
  const match = /^(pnpm|yarn|npm|bun)@(\d+)?/.exec(field);
  if (!match) return null;
  return { manager: match[1] as PackageManager, major: match[2] ? Number(match[2]) : null };
}

/**
 * What to run to install this directory's dependencies, or null when it should not be touched.
 *
 * Null covers: no package.json, node_modules already there, and no lockfile. A missing lockfile
 * means the project never pinned its dependencies, and resolving them fresh is a different act
 * from restoring a known set. Only frozen installs are ever run, so this cannot rewrite one.
 */
export async function planInstall(directory: string): Promise<InstallPlan | null> {
  const pkg = await readPackageJson(directory);
  if (!pkg) return null;
  if (await exists(join(directory, 'node_modules'))) return null;

  const has = {
    pnpm: await exists(join(directory, 'pnpm-lock.yaml')),
    yarn: await exists(join(directory, 'yarn.lock')),
    npm: await exists(join(directory, 'package-lock.json')),
    bun: (await exists(join(directory, 'bun.lock'))) || (await exists(join(directory, 'bun.lockb'))),
  };
  const fromLockfile = (['pnpm', 'yarn', 'npm', 'bun'] as const).find(manager => has[manager]);
  if (!fromLockfile) return null;

  const declared = declaredManager(pkg.packageManager);
  const manager = declared?.manager ?? fromLockfile;

  switch (manager) {
    case 'pnpm':
      return { manager, command: 'pnpm install --frozen-lockfile' };
    case 'npm':
      return { manager, command: 'npm ci' };
    case 'bun':
      return { manager, command: 'bun install --frozen-lockfile' };
    case 'yarn': {
      const berry = declared ? (declared.major ?? 1) >= 2 : await exists(join(directory, '.yarnrc.yml'));
      return { manager, command: berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile' };
    }
  }
}

interface Install {
  processId: string;
  command: string;
}

export type InstallWait = 'done' | 'failed' | 'timeout' | 'none';

export interface InstallRequest {
  sessionId: string;
  workingDirectory: string;
  outcome: WorkspaceOutcome;
}

/**
 * Installs a freshly created worktree's dependencies.
 *
 * Doing it here moves the wait to the start of the session instead of whenever the model
 * happens to trip over the missing node_modules.
 *
 * Only ever after the app created the worktree itself: install scripts run arbitrary code, so
 * merely opening a folder must not trigger one.
 */
export class DependencyInstaller {
  private readonly installs = new Map<string, Install>();
  /** A start still planning, so waitFor called right after maybeStart does not see 'none'. */
  private readonly starting = new Map<string, Promise<void>>();

  constructor(
    private readonly registry: Pick<BackgroundProcessRegistry, 'start' | 'get' | 'tail' | 'settle'>,
    private readonly now: () => number = Date.now
  ) {}

  async maybeStart(request: InstallRequest): Promise<void> {
    const pending = this.start(request);
    this.starting.set(request.sessionId, pending);
    try {
      await pending;
    } finally {
      if (this.starting.get(request.sessionId) === pending) this.starting.delete(request.sessionId);
    }
  }

  /** Whether this session has an install still running, once any start under way has planned. */
  async isInstalling(sessionId: string): Promise<boolean> {
    await this.starting.get(sessionId)?.catch(() => undefined);
    const install = this.installs.get(sessionId);
    return install ? this.registry.get(install.processId, sessionId)?.status === 'running' : false;
  }

  /** Wait up to `ms` (ms) for this session's install to end; 'none' when there is no install. */
  async waitFor(sessionId: string, ms: number): Promise<InstallWait> {
    const startedAt = this.now();
    // A start that threw leaves no install behind, which is what the lookup below reports.
    await this.starting.get(sessionId)?.catch(() => undefined);
    const install = this.installs.get(sessionId);
    if (!install) return 'none';
    await this.registry.settle(install.processId, Math.max(0, ms - (this.now() - startedAt)));
    const info = this.registry.get(install.processId, sessionId);
    if (!info) return 'none';
    if (info.status === 'running') return 'timeout';
    return info.status === 'exited' && info.exitCode === 0 ? 'done' : 'failed';
  }

  private async start(request: InstallRequest): Promise<void> {
    if (request.outcome !== 'created') return;
    const plan = await planInstall(request.workingDirectory);
    if (!plan) return;

    const info = await this.registry.start({
      sessionId: request.sessionId,
      command: plan.command,
      cwd: request.workingDirectory,
      roots: [request.workingDirectory],
      protectedPaths: [],
    });
    this.installs.set(request.sessionId, { processId: info.id, command: plan.command });
  }

  /**
   * Coarse on purpose: this text is part of the system prompt, so it changes only when the
   * install starts, ends, or fails - never with progress - and prompt caching mostly survives.
   */
  promptLines(sessionId: string, { spawned = false }: { spawned?: boolean } = {}): string[] {
    const install = this.installs.get(sessionId);
    if (!install) return [];
    const info = this.registry.get(install.processId, sessionId);
    if (!info) {
      this.installs.delete(sessionId);
      return [];
    }
    return describe(
      info,
      install,
      () => this.registry.tail(install.processId, sessionId, FAILURE_TAIL_CHARS),
      this.now(),
      spawned
    );
  }
}

function describe(
  info: BackgroundProcessInfo,
  install: Install,
  tail: () => string | null,
  now: number,
  spawned: boolean
): string[] {
  const handle = `handle ${install.processId}, \`${install.command}\``;
  if (info.status === 'running') {
    return [
      `Dependencies are installing in the background (${handle}). Do not poll it with bash_output:`,
      'you are told automatically when it finishes. Do not start another install.',
      // A spawned agent's turn ending counts as the agent finishing, so it cannot wait by ending it.
      ...(spawned
        ? [
            'Do other work that does not need node_modules first, and never call bash_output repeatedly',
            'with the same id.',
          ]
        : []),
    ];
  }
  if (info.status === 'killed') return [];
  if (info.status === 'exited' && info.exitCode === 0) {
    const endedAt = info.endedAt ? Date.parse(info.endedAt) : now;
    return now - endedAt > DONE_NOTE_MS
      ? []
      : [`Dependencies finished installing (${handle}). Do not run the install again.`];
  }
  const reason =
    info.error ?? (info.exitCode != null ? `exited ${info.exitCode}` : `killed by ${info.signal ?? 'a signal'}`);
  const output = tail()?.trim();
  return [
    `The background dependency install failed (${handle}): ${reason}. node_modules is missing or`,
    'incomplete. Tell the user rather than retrying blindly.',
    ...(output ? ['Last output:', output] : []),
  ];
}
