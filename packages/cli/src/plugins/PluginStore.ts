import { promises as fs } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { z } from 'zod';

/**
 * Discovery for externally-installed CLI plugins.
 *
 * Plugins are npm packages installed under ~/.bike4mind/plugins (via
 * `b4m plugin add`, which runs `npm install --prefix` there) that declare a
 * `b4m-plugin` field in their package.json:
 *
 *   { "b4m-plugin": { "entry": "./dist/index.js", "configKey": "my-plugin" } }
 *
 * This module is read-only: it enumerates installed packages and validates
 * manifests, producing descriptors the loader (src/features/loadPlugin.ts),
 * `b4m plugin list`, and the /config editor all consume. It never imports
 * plugin code and never throws from discover() - a broken package becomes an
 * invalid descriptor with a reason.
 */

/** Feature keys owned by built-in modules; plugins may not claim them. */
export const RESERVED_BUILTIN_KEYS = ['tavern'];

// Names that resolve on Object.prototype: a configKey like 'constructor' or
// '__proto__' would make a bracket read (config.features[configKey]) truthy
// even when the user never set the key, defeating the enable gate. Reject them
// at discovery so such a plugin is never loadable.
const PROTOTYPE_POLLUTING_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const B4mPluginManifestSchema = z.object({
  entry: z.string().min(1),
  configKey: z.string().min(1).optional(),
});

const PluginPackageJsonSchema = z.looseObject({
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  'b4m-plugin': B4mPluginManifestSchema.optional(),
});

export interface ValidPluginDescriptor {
  valid: true;
  /** package.json "name", e.g. "@someone/b4m-plugin-foo" */
  name: string;
  version: string;
  description: string;
  packageDir: string;
  /** Absolute, containment-verified path to the manifest's entry module */
  entryAbsPath: string;
  /** config.features key gating this plugin; defaults to the package name */
  configKey: string;
}

export interface InvalidPluginDescriptor {
  valid: false;
  /** package.json "name" when readable, else the directory name */
  name: string;
  packageDir: string;
  reason: string;
}

export type PluginDescriptor = ValidPluginDescriptor | InvalidPluginDescriptor;

export interface PluginStoreOptions {
  /** Override the plugins root (defaults to ~/.bike4mind/plugins); for tests. */
  pluginsDir?: string;
}

export function getDefaultPluginsDir(): string {
  return path.join(homedir(), '.bike4mind', 'plugins');
}

/**
 * A plugin is enabled only by an OWN features key set to exactly true. The
 * own-property + strict check guards against a configKey that names an
 * Object.prototype member (e.g. 'constructor') reading back truthy through the
 * prototype chain. Single source of truth for the loader gate, the config
 * editor toggle, and `b4m plugin list`.
 */
export function isFeatureEnabled(
  features: Record<string, boolean | undefined> | undefined,
  configKey: string
): boolean {
  if (!features || !Object.prototype.hasOwnProperty.call(features, configKey)) {
    return false;
  }
  return features[configKey] === true;
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
}

export class PluginStore {
  private readonly pluginsDir: string;

  constructor(options?: PluginStoreOptions) {
    this.pluginsDir = options?.pluginsDir ?? getDefaultPluginsDir();
  }

  getPluginsDir(): string {
    return this.pluginsDir;
  }

  /**
   * Scan the plugins tree and return a descriptor per plugin package, valid or
   * not. Packages without a b4m-plugin field (a plugin's own transitive deps
   * land in the same node_modules) are skipped silently. First-wins dedup by
   * package name across roots and by configKey across plugins.
   */
  async discover(): Promise<PluginDescriptor[]> {
    // npm flat-hoists a plugin's transitive deps into the same node_modules, so
    // most entries are not plugins. Parse them concurrently (Promise.all keeps
    // array order, so the first-wins dedup below stays deterministic).
    const packageDirs: string[] = [];
    for (const root of this.candidateRoots()) {
      packageDirs.push(...(await this.enumeratePackageDirs(root)));
    }
    const parsed = await Promise.all(packageDirs.map(dir => this.parseManifest(dir)));

    const descriptors: PluginDescriptor[] = [];
    const seenPackages = new Set<string>();
    for (const descriptor of parsed) {
      if (!descriptor || seenPackages.has(descriptor.name)) {
        continue;
      }
      seenPackages.add(descriptor.name);
      descriptors.push(descriptor);
    }

    return this.dedupeConfigKeys(descriptors);
  }

  getValid(descriptors: PluginDescriptor[]): ValidPluginDescriptor[] {
    return descriptors.filter((d): d is ValidPluginDescriptor => d.valid);
  }

  getInvalid(descriptors: PluginDescriptor[]): InvalidPluginDescriptor[] {
    return descriptors.filter((d): d is InvalidPluginDescriptor => !d.valid);
  }

  /** node_modules is what `npm install --prefix` produces; lib/node_modules covers a `-g --prefix` install. */
  private candidateRoots(): string[] {
    return [path.join(this.pluginsDir, 'node_modules'), path.join(this.pluginsDir, 'lib', 'node_modules')];
  }

  private async enumeratePackageDirs(root: string): Promise<string[]> {
    const dirs: string[] = [];
    for (const entry of await this.readDirEntries(root)) {
      if (entry.startsWith('.')) {
        continue;
      }
      if (entry.startsWith('@')) {
        // Scope dir: packages live one level down (@scope/name).
        for (const scoped of await this.readDirEntries(path.join(root, entry))) {
          if (!scoped.startsWith('.')) {
            dirs.push(path.join(root, entry, scoped));
          }
        }
      } else {
        dirs.push(path.join(root, entry));
      }
    }
    return dirs;
  }

  private async readDirEntries(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name);
    } catch {
      // Missing plugins dir / root is the normal empty state.
      return [];
    }
  }

  /** Returns null for "not a plugin package" (skipped), a descriptor otherwise. */
  private async parseManifest(packageDir: string): Promise<PluginDescriptor | null> {
    // Reconstruct the scoped name from the layout (@scope/name) so a package
    // whose manifest can't be read/parsed still gets a name `plugin remove`
    // can target, not just the unscoped leaf.
    const parent = path.basename(path.dirname(packageDir));
    const dirName = parent.startsWith('@') ? `${parent}/${path.basename(packageDir)}` : path.basename(packageDir);
    let rawJson: string;
    try {
      rawJson = await fs.readFile(path.join(packageDir, 'package.json'), 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return null; // not a package dir
      }
      return { valid: false, name: dirName, packageDir, reason: 'package.json is unreadable' };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJson);
    } catch {
      return { valid: false, name: dirName, packageDir, reason: 'package.json is not valid JSON' };
    }

    const pkg = PluginPackageJsonSchema.safeParse(parsedJson);
    if (!pkg.success) {
      // Prefer the real package.json name even when the manifest is invalid:
      // basename(packageDir) drops the scope for @scope/foo, so `plugin remove`
      // would target the wrong (unscoped) package name and silently no-op.
      const declaredName = (parsedJson as { name?: unknown })?.name;
      return {
        valid: false,
        name: typeof declaredName === 'string' && declaredName.length > 0 ? declaredName : dirName,
        packageDir,
        reason: formatZodIssues(pkg.error),
      };
    }
    if (!pkg.data['b4m-plugin']) {
      return null; // ordinary dependency, not a plugin
    }

    const manifest = pkg.data['b4m-plugin'];
    const name = pkg.data.name;

    // The entry must resolve inside the package: reject ../ traversal and
    // absolute paths so a manifest can't point the loader outside its own dir.
    const entryAbsPath = path.resolve(packageDir, manifest.entry);
    if (!entryAbsPath.startsWith(packageDir + path.sep)) {
      // Must be a file strictly inside the package. Rejecting entryAbsPath ===
      // packageDir (entry '.'/'./ ') too: importing the dir would fall back to
      // the package's own main/exports, making the declared entry advisory.
      return {
        valid: false,
        name,
        packageDir,
        reason: `b4m-plugin.entry must resolve to a file inside the package: ${manifest.entry}`,
      };
    }

    const configKey = manifest.configKey ?? name;
    if (RESERVED_BUILTIN_KEYS.includes(configKey)) {
      return {
        valid: false,
        name,
        packageDir,
        reason: `configKey '${configKey}' is reserved for a built-in feature`,
      };
    }
    if (PROTOTYPE_POLLUTING_KEYS.has(configKey)) {
      return {
        valid: false,
        name,
        packageDir,
        reason: `configKey '${configKey}' is not allowed`,
      };
    }

    return {
      valid: true,
      name,
      version: pkg.data.version ?? '0.0.0',
      description: pkg.data.description ?? '',
      packageDir,
      entryAbsPath,
      configKey,
    };
  }

  private dedupeConfigKeys(descriptors: PluginDescriptor[]): PluginDescriptor[] {
    const claimed = new Map<string, string>();
    return descriptors.map(descriptor => {
      if (!descriptor.valid) {
        return descriptor;
      }
      const owner = claimed.get(descriptor.configKey);
      if (owner) {
        return {
          valid: false as const,
          name: descriptor.name,
          packageDir: descriptor.packageDir,
          reason: `duplicate configKey '${descriptor.configKey}' already claimed by ${owner}`,
        };
      }
      claimed.set(descriptor.configKey, descriptor.name);
      return descriptor;
    });
  }
}
