import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CustomCommandStore,
  filterAIVisibleSkills,
  filterUserVisibleSkills,
  type CustomCommand,
  type RemoteSkillSource,
} from '@bike4mind/cli/skills';
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
  private readonly inFlight = new Map<string, Promise<CustomCommand[]>>();
  private changes = 0;

  constructor(
    private readonly trust: ProjectTrustStore,
    private readonly remote: RemoteSkills = () => null
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
   */
  async forModel(projectRoot: string | null): Promise<CustomCommand[]> {
    const root = projectRoot ? resolve(projectRoot) : null;
    const trusted = root ? await this.trust.isTrusted(root) : false;
    return filterAIVisibleSkills(await this.load(root, trusted));
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
    this.changes++;
  }

  /**
   * The account's skills just changed from this app (a Skill Market import or update), so the next
   * read refetches them inside RemoteSkillSource's TTL instead of waiting it out.
   */
  invalidateAccount(): void {
    this.remote()?.source.invalidate();
    this.cache.clear();
    this.changes++;
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

    const loading = this.scan(key, root, trusted, account?.source).finally(() => this.inFlight.delete(key));
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
    const store = new CustomCommandStore(root ?? homedir(), { remoteSource });
    // Honestly, not to make a test pass: false for an untrusted root is the whole gate, and
    // false for "no project" is what keeps repo skills out of a Chat session.
    store.setProjectTrusted(trusted);
    await store.loadCommands();

    const commands = store.getAllCommands();
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
