import { resolve } from 'node:path';
import {
  PERMISSION_LISTS,
  type ClaudeCodeSourceView,
  type PermissionMutationResult,
  type PermissionRuleLists,
  type PermissionRuleView,
  type PermissionScope,
  type PermissionsState,
} from '@shared/permissions';
import type { ClaudeCodeFile, ClaudeCodeSettings } from './ClaudeCodeSettings';
import type { PermissionRuleStore } from './PermissionRuleStore';
import { type CompiledRule, PermissionRuleSet, type RuleSource, compileRule, parseRule } from './rules';

export interface PermissionScopeKey {
  /** The folder the user picked for the session's project; desktop project rules are keyed on it. */
  project: string | null;
  /** Where the session runs (a worktree, or the project itself): Claude Code's project files are read here. */
  workingDirectory: string | null;
}

export interface PermissionServiceOptions {
  store: PermissionRuleStore;
  claudeCode: ClaudeCodeSettings;
  /** Whether the user trusts a project folder; see ProjectTrustStore. */
  isTrusted(directory: string): Promise<boolean>;
  home: string;
  /** Folders whose contents no allow rule may cover: the app's own data and Claude Code's settings. */
  protectedRoots: readonly string[];
  logger: { warn(message: string): void };
}

export const DESKTOP_USER_RULES_LABEL = 'Desktop rules';
export const DESKTOP_PROJECT_RULES_LABEL = 'Desktop project rules';

const DESKTOP_USER: RuleSource = { id: 'desktop-user', label: DESKTOP_USER_RULES_LABEL };

function desktopProject(directory: string): RuleSource {
  return { id: `desktop-project:${directory}`, label: DESKTOP_PROJECT_RULES_LABEL, path: directory };
}

function views(lists: PermissionRuleLists, native: boolean): PermissionRuleView[] {
  return PERMISSION_LISTS.flatMap(list =>
    lists[list].map(rule => {
      const parsed = parseRule(rule, { native });
      return parsed.ok ? { rule, list } : { rule, list, problem: parsed.reason };
    })
  );
}

/**
 * The effective permission rules for a session: the desktop's own, plus Claude Code's when shared.
 *
 * Compiled once per (project, working directory) and cached until something changes - a write
 * here, a watched file, a trust decision - so a tool call costs a map lookup. An untrusted
 * project's Claude Code files still contribute deny and ask rules: a cloned repository may not
 * grant itself anything, but it may make the app more careful.
 */
export class PermissionService {
  private readonly cache = new Map<string, Promise<PermissionRuleSet>>();
  private readonly warned = new Set<string>();

  constructor(private readonly options: PermissionServiceOptions) {}

  async start(): Promise<void> {
    await Promise.all([this.options.store.read(), this.options.claudeCode.loadUser()]);
  }

  dispose(): void {
    this.options.claudeCode.dispose();
    this.invalidate();
  }

  /** Drop every compiled set; the next call recompiles from what is in memory. */
  invalidate(): void {
    this.cache.clear();
  }

  rulesFor(scope: PermissionScopeKey): Promise<PermissionRuleSet> {
    const key = `${scope.project ?? ''}\x00${scope.workingDirectory ?? ''}`;
    let compiled = this.cache.get(key);
    if (!compiled) {
      compiled = this.compile(scope);
      this.cache.set(key, compiled);
      const failed = compiled;
      failed.catch(() => this.cache.get(key) === failed && this.cache.delete(key));
    }
    return compiled;
  }

  async state(): Promise<PermissionsState> {
    await this.options.claudeCode.loadUser();
    const stored = await this.options.store.read();
    const trusted = new Map<string, boolean>();
    const claudeCode: ClaudeCodeSourceView[] = [];
    for (const file of this.options.claudeCode.allFiles()) {
      const project = file.scope === 'project' ? file.root : null;
      if (project && !trusted.has(project)) trusted.set(project, await this.options.isTrusted(project));
      const untrusted = project !== null && trusted.get(project) === false;
      claudeCode.push({
        id: file.id,
        label: project ? `${file.label}: ${project}` : file.label,
        path: file.path,
        status: file.status,
        ...(untrusted && file.lists.allow.length > 0
          ? { note: 'This project is not trusted, so its allow rules are ignored; its ask and deny rules apply.' }
          : {}),
        rules: views(file.lists, false),
        additionalDirectories: file.additionalDirectories,
      });
    }
    return {
      shareClaudeCode: stored.shareClaudeCode,
      user: views(stored.user, true),
      projects: Object.entries(stored.projects).map(([directory, lists]) => ({ directory, rules: views(lists, true) })),
      claudeCode,
    };
  }

  async setRules(scope: PermissionScope, lists: PermissionRuleLists): Promise<PermissionMutationResult> {
    for (const list of PERMISSION_LISTS) {
      for (const rule of lists[list] ?? []) {
        const parsed = parseRule(rule, { native: true });
        if (!parsed.ok) return { ok: false, error: `${rule}: ${parsed.reason}` };
      }
    }
    await this.options.store.setLists(
      scope.kind === 'user' ? scope : { kind: 'project', directory: resolve(scope.directory) },
      lists
    );
    this.invalidate();
    return { ok: true, state: await this.state() };
  }

  async setShareClaudeCode(share: boolean): Promise<PermissionsState> {
    await this.options.store.setShareClaudeCode(share);
    this.invalidate();
    return this.state();
  }

  /** Only the approval card calls this, with rules main derived from the call - never text from the renderer. */
  async rememberAllows(rules: readonly string[]): Promise<void> {
    const valid = rules.filter(rule => parseRule(rule, { native: true }).ok);
    if (valid.length === 0) return;
    await this.options.store.addUserAllows(valid);
    this.invalidate();
  }

  async revokeAllow(scope: PermissionScope, rule: string): Promise<boolean> {
    const stored = await this.options.store.read();
    const lists =
      scope.kind === 'user'
        ? stored.user
        : (stored.projects[resolve(scope.directory)] ?? { allow: [], ask: [], deny: [] });
    if (!lists.allow.includes(rule)) return false;
    await this.options.store.setLists(scope, { ...lists, allow: lists.allow.filter(entry => entry !== rule) });
    this.invalidate();
    return true;
  }

  private async compile(scope: PermissionScopeKey): Promise<PermissionRuleSet> {
    const { home, store, claudeCode, protectedRoots } = this.options;
    const stored = await store.read();
    const project = scope.project ? resolve(scope.project) : null;
    const working = scope.workingDirectory ? resolve(scope.workingDirectory) : null;
    const cwd = working ?? project;
    const rules: CompiledRule[] = [];

    const add = (
      lists: PermissionRuleLists,
      source: RuleSource,
      native: boolean,
      root: string | null,
      allows = true
    ) => {
      for (const list of PERMISSION_LISTS) {
        if (list === 'allow' && !allows) continue;
        for (const text of lists[list]) {
          const parsed = parseRule(text, { native });
          if (!parsed.ok) {
            this.warnOnce(source, text, parsed.reason);
            continue;
          }
          const compiled = compileRule(parsed.rule, list, source, { home, root, cwd });
          if (compiled) rules.push(compiled);
        }
      }
    };

    if (stored.shareClaudeCode) {
      await claudeCode.loadUser();
      if (working) await claudeCode.loadProject(working);
      const trusted = working ? await this.options.isTrusted(working) : false;
      for (const file of claudeCode.filesFor(working)) {
        if (file.status === 'unreadable') throw new Error(`Cannot read permission rules in ${file.path}`);
        if (file.status !== 'loaded') continue;
        add(file.lists, sourceOf(file), false, file.root, file.scope !== 'project' || trusted);
      }
    }
    if (project && stored.projects[project]) add(stored.projects[project], desktopProject(project), true, project);
    add(stored.user, DESKTOP_USER, true, home);
    return new PermissionRuleSet(rules, protectedRoots);
  }

  private warnOnce(source: RuleSource, text: string, reason: string): void {
    const key = `${source.id}\x00${text}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.options.logger.warn(`PERMISSIONS: ignoring "${text}" in ${source.path ?? source.label}: ${reason}`);
  }
}

function sourceOf(file: ClaudeCodeFile): RuleSource {
  return { id: file.id, label: file.label, path: file.path };
}
