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
import {
  PluginStore,
  getDefaultPluginsDir,
  type PluginDescriptor,
  type ValidPluginDescriptor,
} from '../plugins/PluginStore.js';

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
  if (!spec || /\s/.test(spec) || /[;&|<>`$(){}\\!*?[\]'"]/.test(spec)) {
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
      const enabled = config.features?.[descriptor.configKey] === true;
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

function runNpm(args: string[], cwd: string): void {
  // Arg-vector form: user-supplied specs never touch a shell on posix. The
  // npm shim on Windows is npm.cmd and needs a shell; validatePluginSpec's
  // metacharacter rejection is the guard that keeps that path safe.
  const isWindows = process.platform === 'win32';
  execFileSync(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: 'inherit',
    timeout: NPM_TIMEOUT_MS,
    shell: isWindows,
  });
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

  try {
    runNpm(['install', '--prefix', pluginsDir, '--no-fund', '--no-audit', spec], pluginsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      console.error('❌ npm is required to install plugins. Install Node.js/npm and retry.');
    } else {
      console.error(`❌ Install failed for ${spec} - see npm output above.`);
    }
    process.exit(1);
  }

  const after = await store.discover();
  const added = after.filter(d => !before.has(d.name));

  if (added.length === 0) {
    console.log(`✅ Installed ${spec}.`);
    console.warn('⚠️ No new b4m-plugin package was detected - it will not load as a plugin.');
    return;
  }

  for (const descriptor of added) {
    if (!descriptor.valid) {
      console.warn(`⚠️ ${descriptor.name} installed, but its manifest is invalid: ${descriptor.reason}`);
      console.warn('It will not load until the manifest is fixed.');
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

  try {
    runNpm(['uninstall', '--prefix', pluginsDir, plugin.name], pluginsDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      console.error('❌ npm is required to remove plugins. Install Node.js/npm and retry.');
    } else {
      console.error(`❌ Uninstall failed for ${plugin.name} - see npm output above.`);
    }
    process.exit(1);
  }

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

/** Exported for tests; resolves the plugin-name mapping helpers above. */
export type { PluginCommandArgs, ValidPluginDescriptor };
