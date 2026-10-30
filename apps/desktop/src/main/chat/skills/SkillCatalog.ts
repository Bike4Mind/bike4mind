import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  CustomCommandStore,
  type CachedCommandFile,
  filterAIVisibleSkills,
  filterUserVisibleSkills,
  type CustomCommand,
  type RemoteSkillSource,
} from '@bike4mind/cli/skills';
import type { AuthLogger } from '@bike4mind/client-auth';
import type { SkillSource, SkillSummary, SkillsState } from '@shared/skills';
import type { ProjectTrustStore } from './ProjectTrustStore';

/**
 * Every skill a session may run, loaded by the CLI's own discovery.
 *
 * There is exactly one skill loader in this repository and it lives in `packages/cli`
 * (CustomCommandStore). It already knows the three directory layouts, the SKILL.md naming
 * convention, the frontmatter contract and the symlink containment rule for an untrusted
 * checkout. This class is the desktop's adapter onto it: it decides WHICH root to scan and
 * whether that root is trusted, and turns the result into the summaries the composer draws.
 *
 * The signed-in account's `/api/skills` skills come from the CLI's RemoteSkillSource, handed to
 * the store, so the local-wins merge and the owner/reserved-name filter are the CLI's too. They
 * are the user's own, so they load in every posture: no project, untrusted and trusted alike.
 */

/**
 * The signed-in account's skill source, or null when signed out. Called on every read, so a
 * sign-out or account switch takes effect on the next one. `key` identifies the account and
 * keys every cache below.
 */
export type RemoteSkills = () => { key: string; source: RemoteSkillSource } | null;

/**
 * How long a scan is trusted without a change event. Watchers invalidate a scan the moment a file
 * changes; this only bounds how stale it can get where a watch never fires (a network mount, a root
 * created after the first scan).
 */
const CACHE_MS = 60_000;

/** An editor saves a file as a burst of events; one rescan covers the burst. */
const WATCH_DEBOUNCE_MS = 200;

/** Trusted project roots watched at once. Past this the least recent falls back to the TTL. */
const MAX_WATCHED_PROJECTS = 4;

const COMMAND_DIRS = [
  ['.bike4mind', 'commands'],
  ['.claude', 'commands'],
  ['.claude', 'skills'],
] as const;

interface Cached {
  at: number;
  commands: CustomCommand[];
}

export class SkillCatalog {
  private readonly cache = new Map<string, Cached>();
  private readonly inFlight = new Map<string, Promise<CustomCommand[]>>();
  private readonly fileCache = new Map<string, CachedCommandFile>();
  private readonly aiVisible = new WeakMap<CustomCommand[], readonly CustomCommand[]>();
  private readonly globalWatchers: FSWatcher[] = [];
  /** Trusted project root -> its watchers, least recently scanned first. */
  private readonly projectWatchers = new Map<string, FSWatcher[]>();
  private watchingGlobal = false;
  private debounce: NodeJS.Timeout | null = null;
  /** Bumped on every invalidation, so a scan that started before a change does not cache its result. */
  private generation = 0;
  private changes = 0;

  constructor(
    private readonly trust: ProjectTrustStore,
    private readonly remote: RemoteSkills = () => null,
    private readonly logger?: Pick<AuthLogger, 'debug'>
  ) {}

  /**
   * Moves on a trust decision (`setTrusted`), a Skill Market import (`invalidateAccount`) or a
   * change of signed-in account, and nothing else.
   *
   * The skills a model is SHOWN are snapshotted per session, because the system prompt sits in
   * the provider's cached prefix and must not move between rounds (see SkillsPromptCache). That
   * snapshot would otherwise outlive the one change to this catalog a user makes mid-session and
   * expects to see: trusting the project they are working in, or importing a skill. This is what
   * the snapshot keys on, so those reach the next turn and a skill edit does not.
   */
  get revision(): string {
    return `${this.changes}:${this.remote()?.key ?? 'none'}`;
  }

  /**
   * The skills for a session, and whether a bound project is being withheld.
   *
   * `projectRoot` is null for a Chat session, which has no project binding at all - so it gets
   * global skills only, and a project skill is never OFFERED in a session that could not run
   * it. See ChatService.resolveToolScope for where the root comes from.
   */
  async state(projectRoot: string | null): Promise<SkillsState> {
    const root = projectRoot ? resolve(projectRoot) : null;
    const trusted = root ? await this.trust.isTrusted(root) : false;
    const commands = await this.load(root, trusted);
    return {
      skills: filterUserVisibleSkills(commands).map(toSummary),
      projectDirectory: trusted ? root : null,
      untrustedProject: root && !trusted ? root : null,
    };
  }

  /**
   * The skills the MODEL may see and run: AI-visible, and project skills only from a trusted
   * project. Both the prompt section and the `skill` tool read this, so a skill the model is
   * told about is exactly one it can call, and the not-AI-visible ones are absent from both.
   *
   * Distinct from `state`, which answers the composer's question: a skill may be the user's to
   * invoke and not the model's (`disable-model-invocation`), or the model's and not the
   * picker's (`user-invocable: false`).
   *
   * The same array for as long as one scan is cached, so SkillsPromptCache can build the prompt
   * section once per scan rather than once per session.
   */
  async forModel(projectRoot: string | null): Promise<readonly CustomCommand[]> {
    const root = projectRoot ? resolve(projectRoot) : null;
    const trusted = root ? await this.trust.isTrusted(root) : false;
    const all = await this.load(root, trusted);
    let visible = this.aiVisible.get(all);
    if (!visible) {
      visible = filterAIVisibleSkills(all);
      this.aiVisible.set(all, visible);
    }
    return visible;
  }

  /** One skill by name, for the send path. Undefined when it does not exist or is withheld. */
  async get(projectRoot: string | null, name: string): Promise<CustomCommand | undefined> {
    const root = projectRoot ? resolve(projectRoot) : null;
    const trusted = root ? await this.trust.isTrusted(root) : false;
    return (await this.load(root, trusted)).find(command => command.name === name);
  }

  /**
   * Record a trust decision and drop the cached scans, so the next read reflects it rather than
   * whichever posture happened to be cached seconds ago.
   */
  async setTrusted(projectRoot: string, trusted: boolean): Promise<void> {
    const root = resolve(projectRoot);
    if (trusted) await this.trust.trust(root);
    else await this.trust.revoke(root);
    this.invalidate();
    this.changes++;
  }

  /**
   * The account's skills just changed from this app (a Skill Market import or update), so the next
   * read refetches them inside RemoteSkillSource's TTL instead of waiting it out.
   */
  invalidateAccount(): void {
    this.remote()?.source.invalidate();
    this.invalidate();
    this.changes++;
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    for (const watcher of this.globalWatchers) watcher.close();
    this.globalWatchers.length = 0;
    for (const watchers of this.projectWatchers.values()) for (const watcher of watchers) watcher.close();
    this.projectWatchers.clear();
  }

  /** Deliberately leaves `changes` alone: a skill edit must not move the per-session prompt snapshot. */
  private invalidate(): void {
    this.generation++;
    this.cache.clear();
    this.inFlight.clear();
  }

  private load(root: string | null, trusted: boolean): Promise<CustomCommand[]> {
    const account = this.remote();
    const key = `${trusted ? 'trusted' : 'untrusted'}:${root ?? ''}:${account?.key ?? 'none'}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.commands);

    // The picker and the first turn of a conversation read a cold or past-TTL catalog at the same
    // moment. Both would otherwise build their own store and each hit /api/skills; the first
    // read's promise is shared until it settles.
    const running = this.inFlight.get(key);
    if (running) return running;

    const loading = this.scan(key, root, trusted, account?.source).finally(() => {
      if (this.inFlight.get(key) === loading) this.inFlight.delete(key);
    });
    this.inFlight.set(key, loading);
    return loading;
  }

  private async scan(
    key: string,
    root: string | null,
    trusted: boolean,
    remoteSource: RemoteSkillSource | undefined
  ): Promise<CustomCommand[]> {
    // A session with no project still needs a root for the constructor, and the default is
    // process.cwd() - for a packaged Electron app, wherever the user happened to launch it
    // from. The home directory is passed instead, and `setProjectTrusted` is never called for
    // it, so its project directories are not scanned and only ~/.claude/skills loads.
    const startedAt = performance.now();
    const generation = this.generation;
    this.watch(root, trusted);
    const store = new CustomCommandStore(root ?? homedir(), { remoteSource, fileCache: this.fileCache });
    // Honestly, not to make a test pass: false for an untrusted root is the whole gate, and
    // false for "no project" is what keeps repo skills out of a Chat session.
    store.setProjectTrusted(trusted);
    await store.loadCommands();

    const commands = store.getAllCommands();
    this.logger?.debug(
      `SKILLS: scanned ${commands.length} commands for ${key} in ${Math.round(performance.now() - startedAt)}ms`
    );
    if (generation === this.generation) this.cache.set(key, { at: Date.now(), commands });
    return commands;
  }

  /**
   * Watches the roots a scan reads, so the next read after an edit rescans. Bounded by roots, not
   * sessions: the three global directories plus at most MAX_WATCHED_PROJECTS trusted checkouts.
   */
  private watch(root: string | null, trusted: boolean): void {
    if (!this.watchingGlobal) {
      this.watchingGlobal = true;
      const home = homedir();
      const rearm = () => {
        for (const watcher of this.globalWatchers) watcher.close();
        this.globalWatchers.length = 0;
        this.watchingGlobal = false;
      };
      for (const parts of COMMAND_DIRS) this.watchDirectory(join(home, ...parts), home, this.globalWatchers, rearm);
    }
    if (!root || !trusted) return;
    const existing = this.projectWatchers.get(root);
    this.projectWatchers.delete(root);
    if (existing) {
      this.projectWatchers.set(root, existing);
      return;
    }
    const watchers: FSWatcher[] = [];
    const rearm = () => {
      if (this.projectWatchers.get(root) !== watchers) return;
      for (const watcher of watchers) watcher.close();
      this.projectWatchers.delete(root);
    };
    for (const parts of COMMAND_DIRS) this.watchDirectory(join(root, ...parts), root, watchers, rearm);
    this.projectWatchers.set(root, watchers);
    for (const [oldest, stale] of this.projectWatchers) {
      if (this.projectWatchers.size <= MAX_WATCHED_PROJECTS) break;
      for (const watcher of stale) watcher.close();
      this.projectWatchers.delete(oldest);
      this.forgetFiles(oldest);
    }
  }

  /** `rearm` drops this root's watchers so the next scan watches it afresh. */
  private watchDirectory(directory: string, stopAt: string, into: FSWatcher[], rearm: () => void): void {
    // Checked rather than caught: on Linux a recursive watch of a missing folder fails later, as
    // an 'error' event, so a throw would never send it to watchForCreation.
    if (!existsSync(directory)) {
      this.watchForCreation(directory, stopAt, into, rearm);
      return;
    }
    try {
      this.track(
        watch(directory, { recursive: true, persistent: false }, () => this.changed()),
        into
      );
    } catch {
      // Not watchable here: the TTL covers it.
    }
  }

  /**
   * A root that does not exist yet, as in a project with no skills so far: the nearest folder that
   * does is watched for the one entry leading to it, and its creation re-arms the root. Without
   * this a first skill would wait out the TTL.
   */
  private watchForCreation(directory: string, stopAt: string, into: FSWatcher[], rearm: () => void): void {
    for (let missing = directory; missing !== stopAt && dirname(missing) !== missing; missing = dirname(missing)) {
      if (!existsSync(dirname(missing))) continue;
      const leading = basename(missing);
      try {
        const watcher = watch(dirname(missing), { persistent: false }, (_event, name) => {
          // No name, or the deeper path, when the platform coalesces a `mkdir -p` into one event.
          if (name && name !== leading && !name.startsWith(leading + sep)) return;
          rearm();
          this.changed();
        });
        this.track(watcher, into);
      } catch {
        // Not watchable here: the TTL covers it.
      }
      return;
    }
  }

  private track(watcher: FSWatcher, into: FSWatcher[]): void {
    watcher.on('error', () => {
      watcher.close();
      const index = into.indexOf(watcher);
      if (index >= 0) into.splice(index, 1);
      this.changed();
    });
    into.push(watcher);
  }

  private changed(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.invalidate();
    }, WATCH_DEBOUNCE_MS);
    this.debounce.unref();
  }

  private forgetFiles(root: string): void {
    const prefix = root.endsWith(sep) ? root : root + sep;
    for (const path of this.fileCache.keys()) if (path.startsWith(prefix)) this.fileCache.delete(path);
  }
}

function toSummary(command: CustomCommand): SkillSummary {
  return {
    name: command.name,
    ...(command.displayName ? { displayName: command.displayName } : {}),
    description: command.description,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    source: skillSource(command),
    ...(command.untrusted ? { imported: true } : {}),
    filePath: command.filePath,
  };
}

/** The renderer's label for where a command came from; `remote` is the signed-in account's. */
export function skillSource(command: CustomCommand): SkillSource {
  if (command.source === 'project') return 'project';
  return command.source === 'remote' ? 'account' : 'global';
}
