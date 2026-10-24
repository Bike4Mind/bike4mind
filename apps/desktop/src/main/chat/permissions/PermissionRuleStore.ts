import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
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

const ruleListsSchema = z.object({
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
const storedPermissionsSchema = z.object({
  shareClaudeCode: z.boolean().default(true),
  user: ruleListsSchema.default({ allow: [], ask: [], deny: [] }),
  projects: z.record(z.string(), ruleListsSchema).default({}),
});

/** Persist consent atomically; only a missing file represents a fresh installation. */
export class PermissionRuleStore {
  private cached: StoredPermissions | null = null;
  private loading: Promise<StoredPermissions> | null = null;

  constructor(private readonly filePath: string) {}

  async read(): Promise<StoredPermissions> {
    if (this.cached) return this.cached;
    this.loading ??= this.load();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async load(): Promise<StoredPermissions> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      raw = {};
    }
    const parsed = storedPermissionsSchema.parse(raw);
    const projects = Object.fromEntries(
      Object.entries(parsed.projects).map(([directory, lists]) => [resolve(directory), readLists(lists)])
    );
    this.cached = { ...parsed, user: readLists(parsed.user), projects };
    return this.cached;
  }

  async setLists(
    scope: { kind: 'user' } | { kind: 'project'; directory: string },
    lists: PermissionRuleLists
  ): Promise<StoredPermissions> {
    return this.update(current => {
      const cleaned = readLists(lists);
      if (scope.kind === 'user') return { ...current, user: cleaned };
      const projects = { ...current.projects };
      const empty = PERMISSION_LISTS.every(list => cleaned[list].length === 0);
      if (empty) delete projects[resolve(scope.directory)];
      else projects[resolve(scope.directory)] = cleaned;
      return { ...current, projects };
    });
  }

  async setShareClaudeCode(share: boolean): Promise<StoredPermissions> {
    return this.update(current => ({ ...current, shareClaudeCode: share }));
  }

  /** The card's "Always allow": user-level allows, added once each. */
  async addUserAllows(rules: readonly string[]): Promise<StoredPermissions> {
    return this.update(current => {
      const allow = [...current.user.allow];
      for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
      return { ...current, user: { ...current.user, allow } };
    });
  }

  // Serialised: two writes sharing one temp file must not interleave.
  private writing: Promise<unknown> = Promise.resolve();

  private update(change: (current: StoredPermissions) => StoredPermissions): Promise<StoredPermissions> {
    const run = this.writing.then(async () => {
      const next = change(await this.read());
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.filePath);
      this.cached = next;
      return next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}
