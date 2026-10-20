import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PERMISSION_LISTS, type PermissionRuleLists } from '@shared/permissions';

export interface StoredPermissions {
  shareClaudeCode: boolean;
  user: PermissionRuleLists;
  /** Keyed by the absolute project folder the user picked, so a rule follows the project into its worktrees. */
  projects: Record<string, PermissionRuleLists>;
}

export function emptyLists(): PermissionRuleLists {
  return { allow: [], ask: [], deny: [] };
}

function readLists(value: unknown): PermissionRuleLists {
  const lists = emptyLists();
  if (!value || typeof value !== 'object') return lists;
  for (const list of PERMISSION_LISTS) {
    const entries = (value as Record<string, unknown>)[list];
    if (Array.isArray(entries)) {
      lists[list] = [
        ...new Set(entries.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')),
      ];
    }
  }
  return lists;
}

/**
 * The desktop's own allow, ask and deny rules, user-level and per project, plus whether Claude
 * Code's rules are shared. Only Settings and an approval card's "Always, in every session" write
 * here; the file is written the way ApprovalModePreference writes its own, 0600 via a rename.
 *
 * A file that cannot be read is no rules and sharing on - the same as a fresh install - rather
 * than an error: losing rules can only make the app ask more, never less.
 */
export class PermissionRuleStore {
  private cached: StoredPermissions | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<StoredPermissions> {
    if (this.cached) return this.cached;
    let parsed: Record<string, unknown> = {};
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (raw && typeof raw === 'object') parsed = raw as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const projects: Record<string, PermissionRuleLists> = {};
    if (parsed.projects && typeof parsed.projects === 'object') {
      for (const [directory, lists] of Object.entries(parsed.projects as Record<string, unknown>)) {
        projects[resolve(directory)] = readLists(lists);
      }
    }
    this.cached = {
      shareClaudeCode: parsed.shareClaudeCode !== false,
      user: readLists(parsed.user),
      projects,
    };
    return this.cached;
  }

  async setLists(
    scope: { kind: 'user' } | { kind: 'project'; directory: string },
    lists: PermissionRuleLists
  ): Promise<StoredPermissions> {
    const current = await this.read();
    const cleaned = readLists(lists);
    if (scope.kind === 'user') return this.write({ ...current, user: cleaned });
    const projects = { ...current.projects };
    const empty = PERMISSION_LISTS.every(list => cleaned[list].length === 0);
    if (empty) delete projects[resolve(scope.directory)];
    else projects[resolve(scope.directory)] = cleaned;
    return this.write({ ...current, projects });
  }

  async setShareClaudeCode(share: boolean): Promise<StoredPermissions> {
    return this.write({ ...(await this.read()), shareClaudeCode: share });
  }

  /** The card's "Always, in every session": user-level allows, added once each. */
  async addUserAllows(rules: readonly string[]): Promise<StoredPermissions> {
    const current = await this.read();
    const allow = [...current.user.allow];
    for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
    return this.write({ ...current, user: { ...current.user, allow } });
  }

  // Serialised: two writes sharing one temp file must not interleave.
  private writing: Promise<unknown> = Promise.resolve();

  private write(next: StoredPermissions): Promise<StoredPermissions> {
    this.cached = next;
    const run = this.writing.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writing = run.catch(() => undefined);
    return run.then(() => next);
  }
}
