import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  MODEL_HOST_LIMITS,
  OLLAMA_SETTING_KEYS,
  OLLAMA_WRITABLE_SETTING_KEYS,
  type OllamaInstall,
  type OllamaSetting,
  type OllamaSettingKey,
  type OllamaSettings,
  type OllamaSettingSourceKind,
} from '@bike4mind/common/modelHub';
import { defaultExec, type ExecLike } from './hardware';
import {
  OLLAMA_ENV_KEYS,
  OLLAMA_SETTING_DEFAULTS,
  ollamaBool,
  ollamaEnvValue,
  type OllamaEnvironment,
} from './ollamaSettings';
import { serviceHome } from './storeDisk';

export const OLLAMA_UNIT = 'ollama.service';
/** The drop-in a model host writes; drop-ins sorting after it, `override.conf` among them, win over it. */
export const MODEL_HOST_DROP_IN = '50-b4m-host.conf';

const SYSTEMCTL_PROPERTIES = [
  'LoadState',
  'ActiveState',
  'MainPID',
  'User',
  'ExecStart',
  'FragmentPath',
  'DropInPaths',
  'EnvironmentFiles',
  'Environment',
];
const ACTIVE_STATES = new Set(['active', 'activating', 'reloading']);
const UNIT_NAME = /^[A-Za-z0-9@_.:-]+\.service$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEPARATORS = ' \t\n\r';
const UNPRINTABLE = '[unprintable]';

const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  s: ' ',
};

/** systemd's cunescape_one on the text after a backslash: the character and how many characters it took, or null. */
function cunescapeOne(text: string): [string, number] | null {
  const char = text[0] ?? '';
  if (Object.hasOwn(SIMPLE_ESCAPES, char)) return [SIMPLE_ESCAPES[char], 1];
  const digits = char === 'x' ? 2 : char === 'u' ? 4 : char === 'U' ? 8 : 0;
  if (digits) {
    const hex = new RegExp(`^[0-9a-fA-F]{${digits}}`).exec(text.slice(1));
    const code = hex ? parseInt(hex[0], 16) : 0;
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
    return [digits === 2 ? String.fromCharCode(code) : String.fromCodePoint(code), digits + 1];
  }
  const octal = /^[0-7]{3}/.exec(text);
  const code = octal ? parseInt(octal[0], 8) : 0;
  return code === 0 || code > 255 ? null : [String.fromCharCode(code), 3];
}

/**
 * Splits an `Environment=` value as systemd's extract_first_word does with EXTRACT_CUNESCAPE|EXTRACT_UNQUOTE.
 * Like config_parse_environ, keeps the words before a malformed one (bad escape, open quote) and drops the rest.
 */
export function splitSystemdWords(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  for (;;) {
    while (i < text.length && SEPARATORS.includes(text[i])) i++;
    if (i >= text.length) return words;
    let word = '';
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const char = text[i];
      if (char === '\\') {
        const escape = cunescapeOne(text.slice(i + 1, i + 10));
        if (!escape) return words;
        word += escape[0];
        i += escape[1];
      } else if (quote) {
        if (char === quote) quote = null;
        else word += char;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (SEPARATORS.includes(char)) {
        break;
      } else {
        word += char;
      }
    }
    if (quote) return words;
    words.push(word);
  }
}

const SHELL_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };

/** Splits a `systemctl show` list: bare words, or ones shell_maybe_quote double-quoted with backslash escapes. */
export function splitSystemctlWords(text: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (SEPARATORS.includes(text[i])) {
      i++;
    } else if (text[i] !== '"') {
      const start = i;
      while (i < text.length && !SEPARATORS.includes(text[i])) i++;
      words.push(text.slice(start, i));
    } else {
      let word = '';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] !== '\\' || i + 1 >= text.length) {
          word += text[i];
          continue;
        }
        const octal = /^[0-7]{3}/.exec(text.slice(i + 1, i + 4));
        word += octal ? String.fromCharCode(parseInt(octal[0], 8)) : (SHELL_ESCAPES[text[i + 1]] ?? text[i + 1]);
        i += octal ? 3 : 1;
      }
      i++;
      words.push(word);
    }
  }
  return words;
}

/** `KEY=VALUE` words with a valid name and an allowlisted key; anything else is never held. */
function assignments(words: string[]): Array<[string, string]> {
  return words.flatMap((word): Array<[string, string]> => {
    const separator = word.indexOf('=');
    const key = word.slice(0, separator);
    return separator > 0 && ENV_NAME.test(key) && OLLAMA_ENV_KEYS.has(key) ? [[key, word.slice(separator + 1)]] : [];
  });
}

export type UnitEnvironmentEvent = { kind: 'set'; key: string; value: string } | { kind: 'reset' };

const trailingBackslashes = (line: string) => line.length - line.replace(/\\+$/, '').length;

/**
 * Allowlisted `Environment=` assignments in a `[Service]` section, in order; an empty one resets the list. Lines join
 * as in systemd's conf-parser: comments skipped even mid-continuation, an odd run of trailing backslashes continues.
 */
export function parseUnitEnvironment(text: string): UnitEnvironmentEvent[] {
  const events: UnitEnvironmentEvent[] = [];
  let section = '';
  const handle = (line: string) => {
    if (/^\[.+\]$/.test(line)) {
      section = line.slice(1, -1);
      return;
    }
    const match = /^Environment\s*=(.*)$/.exec(line);
    if (section !== 'Service' || !match) return;
    const value = match[1].trim();
    if (!value) events.push({ kind: 'reset' });
    for (const [key, assigned] of assignments(splitSystemdWords(value))) {
      events.push({ kind: 'set', key, value: assigned });
    }
  };
  let continuation: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]*[#;]/.test(raw)) continue;
    const line: string = (continuation ?? '') + raw;
    if (trailingBackslashes(raw) % 2 === 1) {
      continuation = `${line.slice(0, -1)} `;
      continue;
    }
    continuation = null;
    handle(line.trim());
  }
  if (continuation !== null) handle(continuation.trim());
  return events;
}

/** Allowlisted `KEY=VALUE` lines of an `EnvironmentFile=`; `#` and `;` start comments, quotes are removed. */
export function parseEnvironmentFile(text: string): Array<[string, string]> {
  return text
    .replace(/\\\r?\n/g, '')
    .split(/\r?\n/)
    .flatMap((raw): Array<[string, string]> => {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) return [];
      const separator = line.indexOf('=');
      const key = line.slice(0, separator).trim();
      if (separator <= 0 || !ENV_NAME.test(key) || !OLLAMA_ENV_KEYS.has(key)) return [];
      const value = line.slice(separator + 1).trim();
      const quoted = /^(["'])(.*)\1$/.exec(value);
      if (!quoted) return [[key, value]];
      return [[key, quoted[1] === '"' ? quoted[2].replace(/\\(["\\$`])/g, '$1') : quoted[2]]];
    });
}

export interface SystemdUnit {
  scope: 'system' | 'user';
  loadState: string | null;
  activeState: string | null;
  mainPid: number | null;
  user: string | null;
  execPath: string | null;
  fragmentPath: string | null;
  dropInPaths: string[];
  environmentFiles: Array<{ path: string; optional: boolean }>;
  /** The allowlisted part of the merged `Environment=` list systemd reports; null when the property was missing. */
  environment: OllamaEnvironment | null;
  /** systemd 245 and older print `[unprintable]` for a value with a space or newline, so it is missing above. */
  environmentUnprintable: boolean;
}

/** Parses `systemctl show -p ...` output for the properties in SYSTEMCTL_PROPERTIES. */
export function parseSystemctlShow(stdout: string, scope: SystemdUnit['scope']): SystemdUnit {
  const unit: SystemdUnit = {
    scope,
    loadState: null,
    activeState: null,
    mainPid: null,
    user: null,
    execPath: null,
    fragmentPath: null,
    dropInPaths: [],
    environmentFiles: [],
    environment: null,
    environmentUnprintable: false,
  };
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === 'LoadState') unit.loadState = value || null;
    else if (key === 'ActiveState') unit.activeState = value || null;
    else if (key === 'MainPID') unit.mainPid = /^[1-9]\d*$/.test(value) ? Number(value) : null;
    else if (key === 'User') unit.user = value || null;
    else if (key === 'ExecStart') unit.execPath = /\bpath=([^ ;]+)/.exec(value)?.[1] ?? null;
    else if (key === 'FragmentPath') unit.fragmentPath = value || null;
    else if (key === 'DropInPaths') unit.dropInPaths = splitSystemctlWords(value);
    else if (key === 'Environment') {
      const words = splitSystemctlWords(value);
      unit.environment = Object.fromEntries(assignments(words));
      unit.environmentUnprintable = words.includes(UNPRINTABLE);
    } else if (key === 'EnvironmentFiles' && value) {
      const file = /^(.*) \(ignore_errors=(yes|no)\)$/.exec(value);
      unit.environmentFiles.push({ path: file?.[1] ?? value, optional: file?.[2] === 'yes' });
    }
  }
  return unit;
}

export interface OllamaHost {
  /** Empty when Ollama listens on every interface. */
  host: string;
  port: number;
}

/** Where an Ollama with this `OLLAMA_HOST` listens, as envconfig.Host reads it. */
export function parseOllamaHost(value: string | undefined): OllamaHost {
  const text = ollamaEnvValue({ OLLAMA_HOST: value }, 'OLLAMA_HOST');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text);
  let hostport = scheme ? text.slice(scheme[0].length) : text;
  let defaultPort = 11434;
  if (scheme?.[1] === 'http') defaultPort = 80;
  if (scheme?.[1] === 'https') defaultPort = 443;
  if (!scheme && text === 'ollama.com') return { host: 'ollama.com', port: 443 };
  hostport = hostport.split('/')[0];
  const split = /^\[([^\]]*)\]:(.*)$/.exec(hostport) ?? /^([^:]*):([^:]*)$/.exec(hostport);
  if (!split) return { host: hostport.replace(/^\[|\]$/g, '') || '127.0.0.1', port: defaultPort };
  const port = Number(split[2]);
  return { host: split[1], port: /^\d+$/.test(split[2]) && port <= 65535 ? port : defaultPort };
}

/** The host and port a URL reaches, the port defaulting by protocol; null for a URL that does not parse. */
function urlTarget(url: string): OllamaHost | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return { host: target.hostname.replace(/^\[|\]$/g, ''), port };
}

const isAnyHost = (host: string) => host === '' || host === '0.0.0.0' || host === '::';
// Go's net.Listen binds "localhost" to 127.0.0.1.
const canonicalHost = (host: string) => (host.toLowerCase() === 'localhost' ? '127.0.0.1' : host.toLowerCase());

/** Whether an Ollama listening on `listen` answers at `url`. */
export function servesUrl(listen: OllamaHost, url: string): boolean {
  const target = urlTarget(url);
  if (!target || listen.port !== target.port) return false;
  return isAnyHost(listen.host) || canonicalHost(listen.host) === canonicalHost(target.host);
}

export interface OllamaProcess {
  pid: number;
  argv: string[];
  /** The executable's path; argv[0] when `/proc/<pid>/exe` belongs to another user. */
  exe: string | null;
  /** Its variables in OLLAMA_ENV_KEYS; null when another user's environment cannot be read. */
  env: OllamaEnvironment | null;
  containerized: boolean;
}

const CONTAINER_CGROUP = /\/docker[-/]|containerd|kubepods|libpod/;

async function readProcText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function procCommands(root: string, comm: string): Promise<Array<{ pid: number; argv: string[] }>> {
  const proc = join(root, 'proc');
  const pids = (await readdir(proc).catch((): string[] => [])).filter(entry => /^\d+$/.test(entry));
  const found = await Promise.all(
    pids.map(async pid => {
      if ((await readProcText(join(proc, pid, 'comm')))?.trim() !== comm) return null;
      const argv = ((await readProcText(join(proc, pid, 'cmdline'))) ?? '').split('\0').filter(Boolean);
      return { pid: Number(pid), argv };
    })
  );
  return found.filter(entry => entry !== null);
}

/** Running `ollama serve` processes this user can see; runners Ollama spawns are left out. */
export async function findOllamaProcesses(root = '/'): Promise<OllamaProcess[]> {
  const servers = (await procCommands(root, 'ollama')).filter(({ argv }) => argv[1] === 'serve' || argv[1] === 'start');
  return Promise.all(
    servers.map(async ({ pid, argv }) => {
      const dir = join(root, 'proc', String(pid));
      const [environ, exe, cgroup] = await Promise.all([
        readProcText(join(dir, 'environ')),
        readlink(join(dir, 'exe')).catch(() => null),
        readProcText(join(dir, 'cgroup')),
      ]);
      const env = environ === null ? null : Object.fromEntries(assignments(environ.split('\0')));
      return { pid, argv, exe: exe ?? argv[0] ?? null, env, containerized: CONTAINER_CGROUP.test(cgroup ?? '') };
    })
  );
}

/** Whether Docker publishes a container port on `port`, as its userland proxy shows. */
async function dockerPublishes(root: string, port: number): Promise<boolean> {
  const proxies = await procCommands(root, 'docker-proxy');
  return proxies.some(({ argv }) => argv.some((arg, i) => arg === '-host-port' && argv[i + 1] === String(port)));
}

export interface OllamaInstallProbe {
  install: OllamaInstall;
  unit: SystemdUnit | null;
  process: OllamaProcess | null;
}

export interface OllamaInstallOptions {
  /** The Ollama to identify; default http://127.0.0.1:11434. */
  url?: string;
  exec?: ExecLike;
  /** Where `/proc` and unit files are read from; tests point it at a fixture tree. */
  rootDir?: string;
  /** A `.service` unit name; anything else finds no unit. */
  unitName?: string;
}

async function attempt<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

async function systemdUnits(exec: ExecLike, unitName: string): Promise<SystemdUnit[]> {
  if (!UNIT_NAME.test(unitName) || unitName.startsWith('-')) return [];
  const args = ['show', ...SYSTEMCTL_PROPERTIES.map(property => `--property=${property}`), '--', unitName];
  const shown = await Promise.all(
    (['system', 'user'] as const).map(async scope => {
      const result = await attempt(() => exec('systemctl', scope === 'user' ? ['--user', ...args] : args));
      return result ? parseSystemctlShow(result.stdout, scope) : null;
    })
  );
  return shown.filter(
    (unit): unit is SystemdUnit =>
      unit !== null && unit.loadState === 'loaded' && ACTIVE_STATES.has(unit.activeState ?? '')
  );
}

async function unitHost(unit: SystemdUnit, root: string): Promise<OllamaHost> {
  let host = unit.environment?.OLLAMA_HOST;
  for (const file of unit.environmentFiles) {
    const text = await readProcText(join(root, file.path));
    const assigned = text === null ? undefined : parseEnvironmentFile(text).findLast(([key]) => key === 'OLLAMA_HOST');
    if (assigned) host = assigned[1];
  }
  return parseOllamaHost(host);
}

const isSnap = (path: string | null) => path?.startsWith('/snap/') ?? false;

/** How the Ollama at `url` is installed and run, and the unit or process behind it. Never throws. */
export async function detectOllamaInstall(options: OllamaInstallOptions = {}): Promise<OllamaInstallProbe> {
  const url = options.url ?? 'http://127.0.0.1:11434';
  const root = options.rootDir ?? '/';
  const [processes, units] = await Promise.all([
    findOllamaProcesses(root).catch((): OllamaProcess[] => []),
    systemdUnits(options.exec ?? defaultExec, options.unitName ?? OLLAMA_UNIT),
  ]);
  const listening = processes.filter(p => p.env !== null && servesUrl(parseOllamaHost(p.env.OLLAMA_HOST), url));

  for (const unit of units) {
    const ownsProcess = unit.mainPid !== null && listening.some(p => p.pid === unit.mainPid);
    if (!ownsProcess && !servesUrl(await unitHost(unit, root), url)) continue;
    const type = isSnap(unit.execPath) ? 'snap' : unit.scope === 'system' ? 'official' : 'user-systemd';
    return {
      install: { type, unit: unit.fragmentPath, binary: unit.execPath },
      unit,
      process: processes.find(p => p.pid === unit.mainPid) ?? null,
    };
  }

  // Another user's process hides its environment; take it when it is the only candidate left.
  const hidden = processes.filter(p => p.env === null);
  const process = listening[0] ?? (hidden.length === 1 ? hidden[0] : null);
  if (process) {
    const type = process.containerized ? 'docker' : isSnap(process.exe) ? 'snap' : 'manual';
    return { install: { type, unit: null, binary: process.exe }, unit: null, process };
  }
  const port = urlTarget(url)?.port;
  const docker = port !== undefined && (await dockerPublishes(root, port).catch(() => false));
  return { install: { type: docker ? 'docker' : 'unknown', unit: null, binary: null }, unit: null, process: null };
}

interface Attributed {
  value: string;
  kind: OllamaSettingSourceKind;
  path: string | null;
}

export interface Attribution {
  values: Map<string, Attributed>;
  unreadablePaths: string[];
  /** A drop-in sorting after the model host's resets `Environment=`, dropping whatever the host writes. */
  resetAfterHostDropIn: boolean;
  /** A drop-in sorting after the model host's, or an environment file, is unreadable and may override it. */
  unreadableAfterHostDropIn: boolean;
}

function fileKind(path: string, unit: SystemdUnit): OllamaSettingSourceKind {
  if (path === unit.fragmentPath) return 'unit';
  return basename(path) === 'override.conf' ? 'override' : 'dropin';
}

const sortsAfterHostDropIn = (path: string, unit: SystemdUnit) =>
  path !== unit.fragmentPath && basename(path) > MODEL_HOST_DROP_IN;

async function readUnitFile(path: string): Promise<{ text: string } | { missing: boolean }> {
  try {
    return { text: await readFile(path, 'utf8') };
  } catch (error) {
    return { missing: error instanceof Error && 'code' in error && error.code === 'ENOENT' };
  }
}

/** Attributes each allowlisted variable systemd gives the unit to the file that sets it, in systemd's order. */
export async function attributeSystemdEnvironment(unit: SystemdUnit, root = '/'): Promise<Attribution> {
  const unreadablePaths: string[] = [];
  let resetAfterHostDropIn = false;
  let unreadableAfterHostDropIn = false;
  const assigned = new Map<string, { value: string; path: string }>();
  for (const path of [unit.fragmentPath, ...unit.dropInPaths].filter((p): p is string => !!p)) {
    const read = await readUnitFile(join(root, path));
    if (!('text' in read)) {
      if (read.missing) continue;
      unreadablePaths.push(path);
      unreadableAfterHostDropIn ||= sortsAfterHostDropIn(path, unit);
      continue;
    }
    for (const event of parseUnitEnvironment(read.text)) {
      if (event.kind === 'reset') {
        assigned.clear();
        resetAfterHostDropIn ||= sortsAfterHostDropIn(path, unit);
      } else {
        assigned.set(event.key, { value: event.value, path });
      }
    }
  }

  const fromFiles = Object.fromEntries([...assigned].map(([key, { value }]) => [key, value]));
  // Old systemd hides a value with a space behind [unprintable]; the readable files still have it.
  const effective = unit.environment
    ? unit.environmentUnprintable
      ? { ...fromFiles, ...unit.environment }
      : unit.environment
    : fromFiles;
  const values = new Map<string, Attributed>();
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined) continue;
    const file = assigned.get(key);
    // systemd expands specifiers, so a value may differ from the file's text; with a file unread, it may be another.
    if (file && (file.value === value || unreadablePaths.length === 0)) {
      values.set(key, { value, kind: fileKind(file.path, unit), path: file.path });
    } else {
      values.set(key, { value, kind: 'unattributed', path: null });
    }
  }

  // EnvironmentFile= values override Environment= ones, later files over earlier ones.
  for (const file of unit.environmentFiles) {
    const read = await readUnitFile(join(root, file.path));
    if (!('text' in read)) {
      if (read.missing) continue;
      unreadablePaths.push(file.path);
      unreadableAfterHostDropIn = true;
      continue;
    }
    for (const [key, value] of parseEnvironmentFile(read.text)) {
      values.set(key, { value, kind: 'env-file', path: file.path });
    }
  }
  return { values, unreadablePaths, resetAfterHostDropIn, unreadableAfterHostDropIn };
}

const WRITABLE = new Set<string>(OLLAMA_WRITABLE_SETTING_KEYS);

/** A model host's drop-in only changes a value it would win over: defaults, the unit, drop-ins sorting before it. */
function isWritable(key: OllamaSettingKey, install: OllamaInstall, source: Attributed | null, from: Attribution) {
  if (!WRITABLE.has(key) || (install.type !== 'official' && install.type !== 'user-systemd')) return false;
  if (from.resetAfterHostDropIn || from.unreadableAfterHostDropIn) return false;
  if (!source || source.kind === 'unit') return true;
  return source.kind === 'dropin' && source.path !== null && basename(source.path) <= MODEL_HOST_DROP_IN;
}

/** `disable_ollama_cloud` from `~/.ollama/server.json`, which envconfig.NoCloud ORs with OLLAMA_NO_CLOUD. */
async function cloudDisabledByConfig(
  home: string,
  root: string
): Promise<{ path: string; disabled: boolean } | { path: string; unreadable: true } | null> {
  const path = join(home, '.ollama', 'server.json');
  const read = await readUnitFile(join(root, path));
  if (!('text' in read)) return read.missing ? null : { path, unreadable: true };
  try {
    const parsed: unknown = JSON.parse(read.text);
    const disabled =
      typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).disable_ollama_cloud;
    return { path, disabled: disabled === true };
  } catch {
    return { path, disabled: false };
  }
}

export interface OllamaSettingsRead {
  settings: OllamaSettings;
  /**
   * The allowlisted variables (OLLAMA_ENV_KEYS) Ollama runs with, for the fit runtime, default context and store:
   * the running process's when readable, else what the unit files say. Empty when unreadable.
   */
  env: OllamaEnvironment;
}

export interface ReadOllamaSettingsOptions {
  rootDir?: string;
  /** This user's home, for a `systemctl --user` Ollama. */
  homeDir?: string;
}

const UNREADABLE_SETTINGS: OllamaSettingsRead = {
  settings: { readable: false, settings: [], unreadablePaths: [] },
  env: {},
};

/**
 * Effective Ollama settings for a detected install and their sources; unset keys show Ollama's default (null context
 * length). A unit's readable process wins, marking values its files have since changed `pendingRestart`. Never throws.
 */
export async function readOllamaSettings(
  probe: OllamaInstallProbe,
  options: ReadOllamaSettingsOptions = {}
): Promise<OllamaSettingsRead> {
  const root = options.rootDir ?? '/';
  const process = probe.process?.env ? { ...probe.process, env: probe.process.env } : null;
  let attribution: Attribution | null = null;
  if (probe.unit) {
    attribution = await attributeSystemdEnvironment(probe.unit, root).catch(() => null);
  } else if (process && probe.install.type !== 'docker') {
    const path = `/proc/${process.pid}/environ`;
    const entries = Object.entries(process.env).flatMap(([key, value]): Array<[string, Attributed]> =>
      value === undefined ? [] : [[key, { value, kind: 'process', path }]]
    );
    attribution = {
      values: new Map(entries),
      unreadablePaths: [],
      resetAfterHostDropIn: false,
      unreadableAfterHostDropIn: false,
    };
  }
  if (!attribution) return UNREADABLE_SETTINGS;

  const { values, unreadablePaths } = attribution;
  const live = probe.unit && process?.pid === probe.unit.mainPid ? process : null;
  const livePath = live ? `/proc/${live.pid}/environ` : null;
  const env: OllamaEnvironment = live
    ? { ...live.env }
    : Object.fromEntries([...values].map(([key, { value }]) => [key, value]));

  const settings = OLLAMA_SETTING_KEYS.map((key): OllamaSetting => {
    const source = values.get(key) ?? null;
    const writable = isWritable(key, probe.install, source, attribution);
    const running = live?.env[key];
    if (live && running !== source?.value) {
      return {
        key,
        value: running ?? OLLAMA_SETTING_DEFAULTS[key],
        source: running === undefined ? { kind: 'default', path: null } : { kind: 'process', path: livePath },
        writable,
        pendingRestart: true,
      };
    }
    return {
      key,
      value: source ? source.value : OLLAMA_SETTING_DEFAULTS[key],
      source: source ? { kind: source.kind, path: source.path } : { kind: 'default', path: null },
      writable,
    };
  });

  if (!ollamaBool(env, 'OLLAMA_NO_CLOUD')) {
    const home = await serviceHome({ env, unit: probe.unit, rootDir: options.rootDir, homeDir: options.homeDir });
    const config = home ? await cloudDisabledByConfig(home, root) : null;
    if (config && 'unreadable' in config) unreadablePaths.push(config.path);
    if (config && 'disabled' in config && config.disabled) {
      const index = settings.findIndex(setting => setting.key === 'OLLAMA_NO_CLOUD');
      settings[index] = {
        key: 'OLLAMA_NO_CLOUD',
        value: '1',
        source: { kind: 'config', path: config.path },
        writable: false,
      };
    }
  }
  return {
    settings: { readable: true, settings, unreadablePaths: unreadablePaths.slice(0, MODEL_HOST_LIMITS.unreadable) },
    env,
  };
}
