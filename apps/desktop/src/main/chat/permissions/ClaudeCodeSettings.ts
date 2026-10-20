import { type FSWatcher, existsSync, unwatchFile, watch, watchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { PermissionRuleLists } from '@shared/permissions';
import { z } from 'zod';
import { emptyLists } from './PermissionRuleStore';

export const MANAGED_SETTINGS_PATH = '/Library/Application Support/ClaudeCode/managed-settings.json';

export type ClaudeCodeScope = 'managed' | 'user' | 'project';

export interface ClaudeCodeFile {
  id: string;
  label: string;
  path: string;
  scope: ClaudeCodeScope;
  /** What a rule's leading `/` is relative to: the project for a project file, home for the user's. */
  root: string | null;
  status: 'loaded' | 'missing' | 'unreadable';
  lists: PermissionRuleLists;
  additionalDirectories: string[];
}

export interface ClaudeCodeSettingsOptions {
  home: string;
  managedPath?: string;
  logger: { warn(message: string): void };
  /** Called after a watched file changed and was read again. */
  onChange(): void;
  debounceMs?: number;
}

const SETTINGS_NAMES = new Set(['settings.json', 'settings.local.json']);

const settingsSchema = z.looseObject({
  permissions: z
    .looseObject({
      allow: z.array(z.string()).optional(),
      ask: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      additionalDirectories: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * Claude Code's settings files, read and never written.
 *
 * Read when the app starts (managed and user files) and when a project is first opened (its
 * `.claude/settings*.json`), then kept in memory: a tool call never reads a file. Each folder
 * holding one is watched, so an edit applies within the debounce without a restart; a folder
 * that does not exist yet is watched for from its parent.
 */
export class ClaudeCodeSettings {
  private readonly files = new Map<string, ClaudeCodeFile>();
  private readonly projects = new Map<string, Promise<void>>();
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly polling = new Map<string, () => void>();
  private userLoaded: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: ClaudeCodeSettingsOptions) {}

  private get managedPath(): string {
    return this.options.managedPath ?? MANAGED_SETTINGS_PATH;
  }

  private userFiles(): Omit<ClaudeCodeFile, 'status' | 'lists' | 'additionalDirectories'>[] {
    const { home } = this.options;
    const folder = join(home, '.claude');
    return [
      {
        id: 'cc-managed',
        label: 'Claude Code managed',
        path: this.managedPath,
        scope: 'managed',
        root: dirname(this.managedPath),
      },
      {
        id: 'cc-user-local',
        label: 'Claude Code user (local)',
        path: join(folder, 'settings.local.json'),
        scope: 'user',
        root: home,
      },
      { id: 'cc-user', label: 'Claude Code user', path: join(folder, 'settings.json'), scope: 'user', root: home },
    ];
  }

  private projectFiles(project: string): Omit<ClaudeCodeFile, 'status' | 'lists' | 'additionalDirectories'>[] {
    const folder = join(project, '.claude');
    return [
      {
        id: `cc-project-local:${project}`,
        label: 'Claude Code project (local)',
        path: join(folder, 'settings.local.json'),
        scope: 'project',
        root: project,
      },
      {
        id: `cc-project:${project}`,
        label: 'Claude Code project',
        path: join(folder, 'settings.json'),
        scope: 'project',
        root: project,
      },
    ];
  }

  loadUser(): Promise<void> {
    this.userLoaded ??= (async () => {
      await Promise.all(this.userFiles().map(file => this.read(file)));
      this.watchFolder(join(this.options.home, '.claude'));
      this.watchFolder(dirname(this.managedPath), true);
    })();
    return this.userLoaded;
  }

  /** Once per project folder per run; later calls wait on the first. */
  loadProject(project: string): Promise<void> {
    const key = resolve(project);
    let loading = this.projects.get(key);
    if (!loading) {
      loading = (async () => {
        await Promise.all(this.projectFiles(key).map(file => this.read(file)));
        this.watchFolder(join(key, '.claude'));
      })();
      this.projects.set(key, loading);
    }
    return loading;
  }

  /** Highest precedence first: managed, the project's local and shared files, then the user's. */
  filesFor(project: string | null): ClaudeCodeFile[] {
    const ids = [
      'cc-managed',
      ...(project ? [`cc-project-local:${resolve(project)}`, `cc-project:${resolve(project)}`] : []),
      'cc-user-local',
      'cc-user',
    ];
    return ids
      .map(id => [...this.files.values()].find(file => file.id === id))
      .filter((file): file is ClaudeCodeFile => !!file);
  }

  /** Every file read so far, user ones first, then each opened project's. */
  allFiles(): ClaudeCodeFile[] {
    const user = this.filesFor(null);
    return [...user, ...[...this.files.values()].filter(file => file.scope === 'project')];
  }

  dispose(): void {
    this.disposed = true;
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const [path, listener] of this.polling) unwatchFile(path, listener);
    this.polling.clear();
    this.watchers.clear();
    this.timers.clear();
  }

  private async read(file: Omit<ClaudeCodeFile, 'status' | 'lists' | 'additionalDirectories'>): Promise<void> {
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing) this.options.logger.warn(`PERMISSIONS: could not read ${file.path}: ${String(error)}`);
      this.files.set(file.path, {
        ...file,
        status: missing ? 'missing' : 'unreadable',
        lists: emptyLists(),
        additionalDirectories: [],
      });
      return;
    }
    try {
      const permissions = settingsSchema.parse(JSON.parse(text)).permissions ?? {};
      this.files.set(file.path, {
        ...file,
        status: 'loaded',
        lists: { allow: permissions.allow ?? [], ask: permissions.ask ?? [], deny: permissions.deny ?? [] },
        additionalDirectories: permissions.additionalDirectories ?? [],
      });
    } catch {
      this.options.logger.warn(
        `PERMISSIONS: could not parse ${file.path}; permission rules unavailable until repaired`
      );
      this.files.set(file.path, { ...file, status: 'unreadable', lists: emptyLists(), additionalDirectories: [] });
    }
  }

  /**
   * Watch a folder for its settings files. A folder that is not there yet is watched for from its
   * parent, unless `existingOnly` - the managed folder is an administrator's, not worth a watch on `/Library`.
   */
  private watchFolder(folder: string, existingOnly = false): void {
    if (this.disposed) return;
    const parent = dirname(folder);
    const parentKey = `${folder}\x00parent`;
    // Keep the parent watch after creation: a folder watch follows the old inode when an
    // editor replaces the entire .claude directory, and would otherwise miss future edits.
    if (!existingOnly && !this.watchers.has(parentKey) && existsSync(parent)) {
      this.listen(
        parent,
        name => name === basename(folder),
        async () => {
          this.watchers.get(folder)?.close();
          this.watchers.delete(folder);
          this.watchFolder(folder);
          await this.reloadFolder(folder);
        },
        parentKey
      );
    }
    if (this.watchers.has(folder) || !existsSync(folder)) return;
    this.listen(
      folder,
      name => SETTINGS_NAMES.has(name) || name === basename(this.managedPath),
      () => this.reloadFolder(folder)
    );
  }

  private listen(folder: string, relevant: (name: string) => boolean, reload: () => Promise<void>, key = folder): void {
    let watcher: FSWatcher;
    try {
      watcher = watch(folder, { persistent: false }, (_event, filename) => {
        if (filename && !relevant(filename.toString())) return;
        clearTimeout(this.timers.get(key));
        const timer = setTimeout(() => {
          this.timers.delete(key);
          if (this.disposed) return;
          void reload()
            .then(() => this.options.onChange())
            .catch(error => {
              this.options.logger.warn(`PERMISSIONS: could not reload ${folder}: ${String(error)}`);
            });
        }, this.options.debounceMs ?? 200);
        timer.unref?.();
        this.timers.set(key, timer);
      });
    } catch (error) {
      this.options.logger.warn(
        `PERMISSIONS: could not watch ${folder}: ${String(error)}; polling settings files instead`
      );
      this.pollKnownFiles();
      return;
    }
    watcher.on('error', error => {
      this.options.logger.warn(
        `PERMISSIONS: watch failed for ${folder}: ${String(error)}; polling settings files instead`
      );
      this.pollKnownFiles();
      watcher.close();
      this.watchers.delete(key);
    });
    this.watchers.set(key, watcher);
  }

  /** Native watches can fail (for example EMFILE); keep rule changes observable with stat polling. */
  private pollKnownFiles(): void {
    if (this.disposed) return;
    const known = [...this.userFiles(), ...[...this.projects.keys()].flatMap(project => this.projectFiles(project))];
    for (const file of known) {
      if (this.polling.has(file.path)) continue;
      const listener = () => {
        if (this.disposed) return;
        void this.read(file)
          .then(() => this.options.onChange())
          .catch(error => {
            this.options.logger.warn(`PERMISSIONS: could not reload ${file.path}: ${String(error)}`);
          });
      };
      watchFile(file.path, { persistent: false, interval: 1000 }, listener);
      this.polling.set(file.path, listener);
    }
  }

  private async reloadFolder(folder: string): Promise<void> {
    const known = [...this.userFiles(), ...[...this.projects.keys()].flatMap(project => this.projectFiles(project))];
    await Promise.all(known.filter(file => dirname(file.path) === folder).map(file => this.read(file)));
  }
}
