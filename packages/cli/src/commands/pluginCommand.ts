/**
 * External plugin commands (b4m plugin list, b4m plugin add, b4m plugin remove).
 * These run outside the interactive CLI session. Plugins install to
 * ~/.bike4mind/plugins via npm --prefix; discovery/validation lives in
 * src/plugins/PluginStore.ts and loading in src/features/loadPlugin.ts.
 */

import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { ConfigStore } from '../storage/ConfigStore.js';
import type { CliConfig } from '../storage/types.js';
import { PluginStore, getDefaultPluginsDir, isFeatureEnabled, type PluginDescriptor } from '../plugins/PluginStore.js';

interface PluginCommandArgs {
  _: (string | number)[];
  spec?: string;
  name?: string;
  [key: string]: unknown;
}

const NPM_TIMEOUT_MS = 120_000;

/**
 * Conservative allowlist over npm's spec grammar: bare and scoped package
 * names (with optional @version/@tag), github:user/repo (optionally #ref),
 * user/repo shorthand, and file:<path>. Defense-in-depth on top of the
 * arg-vector exec - never the primary injection control.
 */
export function validatePluginSpec(spec: string): boolean {
  // `%` is rejected too: under the Windows shell path it would trigger cmd.exe
  // environment-variable expansion.
  if (!spec || /\s/.test(spec) || /[;&|<>`$(){}\\!*?[\]'"%]/.test(spec)) {
    return false;
  }
  // Segments must start alphanumeric so a relative path (../x, .hidden/y)
  // can never masquerade as a package or github shorthand.
  const patterns = [
    /^[a-z0-9][a-z0-9~._-]*(@[a-z0-9~._^>=<-]+)?$/i, // bare name (+ version/tag)
    /^@[a-z0-9][a-z0-9~._-]*\/[a-z0-9][a-z0-9~._-]*(@[a-z0-9~._^>=<-]+)?$/i, // scoped (+ version/tag)
    /^github:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(#[a-z0-9._/-]+)?$/i,
    /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(#[a-z0-9._/-]+)?$/i, // github shorthand
    /^file:.+$/i,
  ];
  return patterns.some(pattern => pattern.test(spec));
}

/** Map a user-supplied name to an installed plugin: configKey, package name, then short name. */
export function resolvePluginByName(
  descriptors: PluginDescriptor[],
  name: string
): { plugin?: PluginDescriptor; candidates?: PluginDescriptor[] } {
  const exact = descriptors.find(d => (d.valid && d.configKey === name) || d.name === name);
  if (exact) {
    return { plugin: exact };
  }
  const shortMatches = descriptors.filter(d => {
    const bare = d.name.replace(/^@[^/]+\//, '');
    return bare === name || bare === `b4m-plugin-${name}`;
  });
  if (shortMatches.length === 1) {
    return { plugin: shortMatches[0] };
  }
  if (shortMatches.length > 1) {
    return { candidates: shortMatches };
  }
  return {};
}

export function formatPluginList(descriptors: PluginDescriptor[], config: CliConfig): string {
  if (descriptors.length === 0) {
    return [
      'No plugins installed.',
      '',
      'Install one with:',
      '  b4m plugin add <npm-package>',
      '  b4m plugin add github:user/repo',
      '  b4m plugin add file:/path/to/local/plugin',
    ].join('\n');
  }

  const lines: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.valid) {
      const enabled = isFeatureEnabled(config.features, descriptor.configKey);
      lines.push(
        `• ${descriptor.name}@${descriptor.version} - ${enabled ? '✅ Enabled' : '⏸️ Disabled'} (key: ${descriptor.configKey})`
      );
      if (descriptor.description) {
        lines.push(`  ${descriptor.description}`);
      }
    } else {
      lines.push(`• ${descriptor.name} - ⚠️ ${descriptor.reason}`);
    }
  }
  return lines.join('\n');
}

/**
 * Run npm with the given args, or print a friendly message and exit. `action`
 * ('install'/'remove') only shapes the error text.
 */
function runNpmOrExit(args: string[], cwd: string, action: string, target: string): void {
  try {
    // Arg-vector form: user-supplied specs never touch a shell on posix. The
    // npm shim on Windows is npm.cmd and needs a shell; validatePluginSpec's
    // metacharacter rejection guards the user spec, and under the shell we
    // double-quote our own path args (e.g. a --prefix under "C:\Users\John
    // Doe\...") so a space in the home dir doesn't split the argument.
    const isWindows = process.platform === 'win32';
    const finalArgs = isWindows ? args.map(a => (/\s/.test(a) ? `"${a}"` : a)) : args;
    execFileSync(isWindows ? 'npm.cmd' : 'npm', finalArgs, {
      cwd,
      stdio: 'inherit',
      timeout: NPM_TIMEOUT_MS,
      shell: isWindows,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`❌ npm is required to ${action} plugins. Install Node.js/npm and retry.`);
    } else {
      console.error(
        `❌ ${action === 'install' ? 'Install' : 'Uninstall'} failed for ${target} - see npm output above.`
      );
    }
    process.exit(1);
  }
}

/** Top-level dependency names recorded in the plugins-dir package.json. */
async function readTopLevelDeps(pluginsDir: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(pluginsDir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    };
    return new Set(Object.keys(raw.dependencies ?? {}));
  } catch {
    return new Set();
  }
}

async function ensurePluginsDir(pluginsDir: string): Promise<void> {
  await fs.mkdir(pluginsDir, { recursive: true });
  const manifestPath = path.join(pluginsDir, 'package.json');
  try {
    await fs.access(manifestPath);
  } catch {
    // A root manifest makes npm record installs as dependencies, which keeps
    // remove/list deterministic.
    await fs.writeFile(manifestPath, JSON.stringify({ name: 'b4m-plugins', private: true, version: '0.0.0' }, null, 2));
  }
}

export async function handleAdd(spec: string, pluginsDir: string, configStore: ConfigStore): Promise<void> {
  if (!validatePluginSpec(spec)) {
    console.error(`❌ Unsupported plugin spec: ${spec}`);
    console.error('Supported forms: <npm-package>, @scope/<package>, github:user/repo, file:<path>');
    process.exit(1);
  }

  await ensurePluginsDir(pluginsDir);

  const store = new PluginStore({ pluginsDir });
  const before = new Set((await store.discover()).map(d => d.name));
  const depsBefore = await readTopLevelDeps(pluginsDir);

  runNpmOrExit(['install', '--prefix', pluginsDir, '--no-fund', '--no-audit', spec], pluginsDir, 'install', spec);

  const after = await store.discover();
  const added = after.filter(d => !before.has(d.name));
  // Only the package(s) npm recorded as a top-level dependency are what the
  // user asked for; npm flat-hoists transitive deps into the same node_modules,
  // so a dependency that happens to carry a b4m-plugin field must NOT be
  // auto-enabled behind the user's back.
  const newTopLevel = new Set([...(await readTopLevelDeps(pluginsDir))].filter(d => !depsBefore.has(d)));

  if (added.length === 0) {
    // Nothing new discovered: either the package carries no b4m-plugin manifest,
    // or it was already installed (a re-add / version bump). Don't claim it's not
    // a plugin in the latter case - point at the list instead.
    const existingPlugins = store.getValid(after);
    if (existingPlugins.length > 0) {
      console.log(`✅ Installed ${spec}. No new plugin package was added (it may already be installed).`);
      console.log('Run `b4m plugin list` to see installed plugins and their enabled state.');
    } else {
      console.log(`✅ Installed ${spec}.`);
      console.warn('⚠️ No b4m-plugin package was detected - it will not load as a plugin.');
    }
    return;
  }

  for (const descriptor of added) {
    if (!descriptor.valid) {
      console.warn(`⚠️ ${descriptor.name} installed, but its manifest is invalid: ${descriptor.reason}`);
      console.warn('It will not load until the manifest is fixed.');
      continue;
    }
    if (!newTopLevel.has(descriptor.name)) {
      // A transitive dependency that ships its own b4m-plugin manifest.
      console.warn(`ℹ️ ${descriptor.name} is a dependency and carries a plugin manifest; not enabling it.`);
      console.warn(`   Enable it explicitly with: b4m plugin add ${descriptor.name}`);
      continue;
    }
    const config = await configStore.load();
    await configStore.save({
      ...config,
      features: { ...config.features, [descriptor.configKey]: true },
    });
    console.log(`✅ Installed ${descriptor.name}@${descriptor.version} (plugin key: ${descriptor.configKey})`);
    console.log(`Enabled feature "${descriptor.configKey}". It will load next time you start b4m.`);
  }
}

export async function handleRemove(name: string, pluginsDir: string, configStore: ConfigStore): Promise<void> {
  const store = new PluginStore({ pluginsDir });
  const descriptors = await store.discover();
  const { plugin, candidates } = resolvePluginByName(descriptors, name);

  if (candidates) {
    console.error(`❌ "${name}" is ambiguous. Matches: ${candidates.map(c => c.name).join(', ')}`);
    process.exit(1);
  }
  if (!plugin) {
    console.error(`❌ No installed plugin matches "${name}".`);
    if (descriptors.length > 0) {
      console.error(`Installed: ${descriptors.map(d => d.name).join(', ')}`);
    }
    process.exit(1);
    return; // unreachable; keeps the type narrowing honest under tests that stub exit
  }

  runNpmOrExit(['uninstall', '--prefix', pluginsDir, plugin.name], pluginsDir, 'remove', plugin.name);

  if (plugin.valid) {
    const config = await configStore.load();
    // Write false rather than deleting: save() deep-merges features with the
    // on-disk map, so a deleted key would be resurrected from disk.
    await configStore.save({
      ...config,
      features: { ...config.features, [plugin.configKey]: false },
    });
  }
  console.log(`✅ Removed plugin ${plugin.name}${plugin.valid ? ` and disabled "${plugin.configKey}"` : ''}.`);
}

async function handleList(pluginsDir: string, configStore: ConfigStore): Promise<void> {
  const store = new PluginStore({ pluginsDir });
  const descriptors = await store.discover();
  const config = await configStore.load();
  console.log('🔌 Plugins');
  console.log('');
  console.log(formatPluginList(descriptors, config));
}

export async function handlePluginCommand(subcommand: string, argv: PluginCommandArgs): Promise<void> {
  const configStore = new ConfigStore();
  const pluginsDir = getDefaultPluginsDir();

  switch (subcommand) {
    case 'list':
      await handleList(pluginsDir, configStore);
      break;

    case 'add':
      if (!argv.spec) {
        console.error('❌ Usage: b4m plugin add <spec>');
        process.exit(1);
      }
      await handleAdd(argv.spec, pluginsDir, configStore);
      break;

    case 'remove':
      if (!argv.name) {
        console.error('❌ Usage: b4m plugin remove <name>');
        process.exit(1);
      }
      await handleRemove(argv.name, pluginsDir, configStore);
      break;

    default:
      console.error(`❌ Unknown plugin subcommand: ${subcommand}`);
      console.error('Available: list, add <spec>, remove <name>');
      process.exit(1);
  }
}
