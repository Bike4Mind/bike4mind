import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { CustomCommandStore, filterUserVisibleSkills, type CustomCommand } from '@bike4mind/cli/skills';
import type { SkillSummary, SkillsState } from '@shared/skills';
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
 * Remote `/api/skills` skills are deliberately not wired: the store takes a RemoteSkillSource
 * and none is passed, so the desktop is local-only. Adding them later is a constructor
 * argument, not a rewrite.
 */

/**
 * How long a scan is reused before the directories are walked again.
 *
 * Short on purpose. The picker opens on a keystroke, so a scan per keystroke would stat a few
 * hundred files while the user types; but a skill the user just wrote has to appear without
 * restarting the app, which a long cache would break. A couple of seconds covers a burst of
 * typing and nothing else.
 */
const CACHE_MS = 2_000;

interface Cached {
  at: number;
  commands: CustomCommand[];
}

export class SkillCatalog {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly trust: ProjectTrustStore) {}

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
    this.cache.clear();
  }

  private async load(root: string | null, trusted: boolean): Promise<CustomCommand[]> {
    const key = `${trusted ? 'trusted' : 'untrusted'}:${root ?? ''}`;
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.commands;

    // A session with no project still needs a root for the constructor, and the default is
    // process.cwd() - for a packaged Electron app, wherever the user happened to launch it
    // from. The home directory is passed instead, and `setProjectTrusted` is never called for
    // it, so its project directories are not scanned and only ~/.claude/skills loads.
    const store = new CustomCommandStore(root ?? homedir());
    // Honestly, not to make a test pass: false for an untrusted root is the whole gate, and
    // false for "no project" is what keeps repo skills out of a Chat session.
    store.setProjectTrusted(trusted);
    await store.loadCommands();

    const commands = store.getAllCommands().filter(command => command.source !== 'remote');
    this.cache.set(key, { at: Date.now(), commands });
    return commands;
  }
}

function toSummary(command: CustomCommand): SkillSummary {
  return {
    name: command.name,
    ...(command.displayName ? { displayName: command.displayName } : {}),
    description: command.description,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    // The store only yields 'global' | 'project' here; 'remote' was filtered out above.
    source: command.source === 'project' ? 'project' : 'global',
    filePath: command.filePath,
  };
}
