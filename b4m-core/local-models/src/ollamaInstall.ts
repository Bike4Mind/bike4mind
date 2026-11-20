import { readdir, readFile, readlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
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
import { defaultExec, withTimeout, type ExecLike } from './hardware';
import { mapConcurrent } from './mapConcurrent';
import {
  OLLAMA_SETTING_DEFAULTS,
  isOllamaEnvKey,
  ollamaBool,
  ollamaEnvValue,
  type OllamaEnvironment,
  type OllamaEnvKey,
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
function assignments(words: string[]): Array<[OllamaEnvKey, string]> {
  return words.flatMap((word): Array<[OllamaEnvKey, string]> => {
    const separator = word.indexOf('=');
    const key = word.slice(0, separator);
    return separator > 0 && isOllamaEnvKey(key) ? [[key, word.slice(separator + 1)]] : [];
  });
}

export type UnitEnvironmentEvent = { kind: 'set'; key: OllamaEnvKey; value: string } | { kind: 'reset' };

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

const ENV_FILE_WHITESPACE = ' \t\n\r';
const ENV_FILE_NEWLINE = '\n\r';
const ENV_FILE_COMMENTS = '#;';
const SHELL_NEED_ESCAPE = '"\\`$';

type EnvFileState =
  | 'pre-key'
  | 'key'
  | 'pre-value'
  | 'value'
  | 'value-escape'
  | 'single-quote'
  | 'double-quote'
  | 'double-quote-escape'
  | 'comment'
  | 'comment-escape';

/**
 * Allowlisted assignments of an `EnvironmentFile=`, in order, by systemd's parse_env_file_internal
 * (src/basic/env-file.c): quotes may open mid-value, an unquoted backslash escapes any character, one inside double
 * quotes only `"\`$`, single quotes keep everything. There is no `export ` prefix: `export KEY` is an invalid name.
 */
export function parseEnvironmentFile(text: string): Array<[OllamaEnvKey, string]> {
  const found: Array<[OllamaEnvKey, string]> = [];
  let state: EnvFileState = 'pre-key';
  let key = '';
  let value = '';
  // last_key_whitespace / last_value_whitespace: where a trailing run of whitespace starts, or null.
  let keyEnd: number | null = null;
  let valueEnd: number | null = null;
  const push = (chompValue: boolean) => {
    const name = keyEnd === null ? key : key.slice(0, keyEnd);
    const assigned = chompValue && valueEnd !== null ? value.slice(0, valueEnd) : value;
    if (isOllamaEnvKey(name)) found.push([name, assigned]);
    key = '';
    value = '';
  };

  for (const char of text) {
    switch (state) {
      case 'pre-key':
        if (ENV_FILE_COMMENTS.includes(char)) state = 'comment';
        else if (!ENV_FILE_WHITESPACE.includes(char)) {
          state = 'key';
          keyEnd = null;
          key += char;
        }
        break;
      case 'key':
        if (ENV_FILE_NEWLINE.includes(char)) {
          state = 'pre-key';
          key = '';
        } else if (char === '=') {
          state = 'pre-value';
          valueEnd = null;
        } else {
          if (!ENV_FILE_WHITESPACE.includes(char)) keyEnd = null;
          else keyEnd ??= key.length;
          key += char;
        }
        break;
      case 'pre-value':
        if (ENV_FILE_NEWLINE.includes(char)) {
          state = 'pre-key';
          push(false);
        } else if (char === "'") state = 'single-quote';
        else if (char === '"') state = 'double-quote';
        else if (char === '\\') state = 'value-escape';
        else if (!ENV_FILE_WHITESPACE.includes(char)) {
          state = 'value';
          value += char;
        }
        break;
      case 'value':
        if (ENV_FILE_NEWLINE.includes(char)) {
          state = 'pre-key';
          push(true);
        } else if (char === '\\') {
          state = 'value-escape';
          valueEnd = null;
        } else {
          if (!ENV_FILE_WHITESPACE.includes(char)) valueEnd = null;
          else valueEnd ??= value.length;
          value += char;
        }
        break;
      case 'value-escape':
        state = 'value';
        if (!ENV_FILE_NEWLINE.includes(char)) value += char;
        break;
      case 'single-quote':
        if (char === "'") state = 'pre-value';
        else value += char;
        break;
      case 'double-quote':
        if (char === '"') state = 'pre-value';
        else if (char === '\\') state = 'double-quote-escape';
        else value += char;
        break;
      case 'double-quote-escape':
        state = 'double-quote';
        if (SHELL_NEED_ESCAPE.includes(char)) value += char;
        else if (char !== '\n') value += `\\${char}`;
        break;
      case 'comment':
        if (char === '\\') state = 'comment-escape';
        else if (ENV_FILE_NEWLINE.includes(char)) state = 'pre-key';
        break;
      case 'comment-escape':
        state = ENV_FILE_NEWLINE.includes(char) ? 'pre-key' : 'comment';
        break;
    }
  }
  if (!['pre-key', 'key', 'comment', 'comment-escape'].includes(state)) push(state === 'value');
  return found;
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
  /**
   * The allowlisted part of the service manager's own environment (`systemctl show-environment`), which every unit
   * inherits below its `Environment=`; absent when it was not read.
   */
  managerEnvironment?: OllamaEnvironment;
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
function canonicalHost(host: string): string {
  const name = host.toLowerCase().replace(/%.*$/, '');
  if (name === 'localhost') return '127.0.0.1';
  return unmapIpv4(isIP(name) === 6 ? new URL(`http://[${name}]`).hostname.slice(1, -1) : name);
}

/**
 * Whether an Ollama listening on `listen` answers at `url`. `resolved` is what a name in `url` resolves to; a listener
 * bound to one of those addresses serves the name.
 */
export function servesUrl(listen: OllamaHost, url: string, resolved: readonly string[] = []): boolean {
  const target = urlTarget(url);
  if (!target || listen.port !== target.port) return false;
  if (isAnyHost(listen.host)) return true;
  const bound = canonicalHost(listen.host);
  return bound === canonicalHost(target.host) || resolved.some(address => canonicalHost(address) === bound);
}

/** This machine's interface addresses and host name. */
function localAddresses(
  os: { networkInterfaces(): ReturnType<typeof networkInterfaces>; hostname(): string } = {
    networkInterfaces,
    hostname,
  }
): string[] {
  const interfaces = Object.values(os.networkInterfaces()).flatMap(entries => entries ?? []);
  return [...interfaces.map(entry => entry.address), os.hostname()];
}

export { localAddresses as machineAddresses };

// URL parsing turns [::ffff:127.0.0.1] into ::ffff:7f00:1.
function unmapIpv4(host: string): string {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex) return host;
  const [high, low] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** Whether a URL's host is this machine: loopback, a wildcard, or one of `local` (its addresses and host name). */
export function isLocalHost(host: string, local: readonly string[]): boolean {
  const name = unmapIpv4(host.toLowerCase());
  if (name === 'localhost' || name === '::1' || isAnyHost(name) || /^127\.\d+\.\d+\.\d+$/.test(name)) return true;
  return local.some(address => unmapIpv4(address.toLowerCase()) === name);
}

export type HostLookup = (name: string) => Promise<string[]>;

const resolveAll: HostLookup = async name => (await lookup(name, { all: true })).map(entry => entry.address);

/**
 * `isLocalHost`, plus a name (FQDN, mDNS) that resolves to loopback or one of `local`. An unresolvable name is not
 * local.
 */
export async function isLocalHostResolved(
  host: string,
  local: readonly string[],
  resolve: HostLookup = resolveAll
): Promise<boolean> {
  if (isLocalHost(host, local)) return true;
  return anyLocalAddress(await resolveName(host, resolve), local);
}

// getaddrinfo cannot be cancelled; stop waiting so a dead resolver does not stall every host probe (ms).
const LOOKUP_TIMEOUT_MS = 1_500;

/** What a host name resolves to; empty for an IP literal, `localhost`, or a name that does not resolve in time. */
async function resolveName(host: string, resolve: HostLookup): Promise<string[]> {
  if (isIP(host) || host.toLowerCase() === 'localhost') return [];
  return (await withTimeout(resolve(host), LOOKUP_TIMEOUT_MS).catch(() => null)) ?? [];
}

const anyLocalAddress = (addresses: readonly string[], local: readonly string[]) =>
  addresses.some(address => isLocalHost(address.replace(/%.*$/, ''), local) && !isAnyHost(address));

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

export interface ProcCommand {
  pid: number;
  comm: string;
  argv: string[];
}

// Bounds open file descriptors: a host has thousands of PIDs, and an EMFILE would read as a missing process.
const PROC_READ_CONCURRENCY = 64;
const SCANNED_COMMANDS = new Set(['ollama', 'docker-proxy']);

/** One pass over `/proc` for the commands detection looks at: `ollama` servers and Docker's port proxies. */
export async function scanProcCommands(root = '/'): Promise<ProcCommand[]> {
  const proc = join(root, 'proc');
  const pids = (await readdir(proc).catch((): string[] => [])).filter(entry => /^\d+$/.test(entry));
  const found = await mapConcurrent(pids, PROC_READ_CONCURRENCY, async pid => {
    const comm = (await readProcText(join(proc, pid, 'comm')))?.trim() ?? '';
    if (!SCANNED_COMMANDS.has(comm)) return null;
    const argv = ((await readProcText(join(proc, pid, 'cmdline'))) ?? '').split('\0').filter(Boolean);
    return { pid: Number(pid), comm, argv };
  });
  return found.filter(entry => entry !== null);
}

/** Running `ollama serve` processes this user can see; runners Ollama spawns are left out. */
export async function findOllamaProcesses(root = '/', commands?: ProcCommand[]): Promise<OllamaProcess[]> {
  const servers = (commands ?? (await scanProcCommands(root))).filter(
    ({ comm, argv }) => comm === 'ollama' && (argv[1] === 'serve' || argv[1] === 'start')
  );
  return mapConcurrent(servers, PROC_READ_CONCURRENCY, async ({ pid, argv }) => {
    const dir = join(root, 'proc', String(pid));
    const [environ, exe, cgroup] = await Promise.all([
      readProcText(join(dir, 'environ')),
      readlink(join(dir, 'exe')).catch(() => null),
      readProcText(join(dir, 'cgroup')),
    ]);
    const env = environ === null ? null : Object.fromEntries(assignments(environ.split('\0')));
    return { pid, argv, exe: exe ?? argv[0] ?? null, env, containerized: CONTAINER_CGROUP.test(cgroup ?? '') };
  });
}

/** Whether Docker publishes a container port on `port`, as its userland proxy shows. */
function dockerPublishes(commands: ProcCommand[], port: number): boolean {
  return commands.some(
    ({ comm, argv }) =>
      comm === 'docker-proxy' && argv.some((arg, i) => arg === '-host-port' && argv[i + 1] === String(port))
  );
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
  /** This machine's addresses and host name; default from os.networkInterfaces() and os.hostname(). */
  localAddresses?: readonly string[];
  /** Every address a host name resolves to; default dns.lookup with all addresses. */
  lookup?: HostLookup;
}

async function attempt<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

/** `systemctl show-environment`: a `KEY=VALUE` a line, newer systemd writing a value as `$'...'` with C escapes. */
export function parseManagerEnvironment(stdout: string): OllamaEnvironment {
  const words = stdout.split(/\r?\n/).flatMap((line): string[] => {
    const quoted = /^([^=]+)=\$'(.*)'$/.exec(line);
    if (!quoted) return [line];
    let value = '';
    for (let i = 0; i < quoted[2].length; i++) {
      if (quoted[2][i] !== '\\') {
        value += quoted[2][i];
        continue;
      }
      const escape = cunescapeOne(quoted[2].slice(i + 1, i + 10));
      if (!escape) return [];
      value += escape[0];
      i += escape[1];
    }
    return [`${quoted[1]}=${value}`];
  });
  return Object.fromEntries(assignments(words));
}

async function systemdUnits(exec: ExecLike, unitName: string): Promise<SystemdUnit[]> {
  if (!UNIT_NAME.test(unitName) || unitName.startsWith('-')) return [];
  const args = ['show', ...SYSTEMCTL_PROPERTIES.map(property => `--property=${property}`), '--', unitName];
  const shown = await Promise.all(
    (['system', 'user'] as const).map(async scope => {
      const scoped = (rest: string[]) => (scope === 'user' ? ['--user', ...rest] : rest);
      const result = await attempt(() => exec('systemctl', scoped(args)));
      const unit = result ? parseSystemctlShow(result.stdout, scope) : null;
      if (!unit || unit.loadState !== 'loaded' || !ACTIVE_STATES.has(unit.activeState ?? '')) return null;
      const manager = await attempt(() => exec('systemctl', scoped(['show-environment'])));
      return manager ? { ...unit, managerEnvironment: parseManagerEnvironment(manager.stdout) } : unit;
    })
  );
  return shown.filter((unit): unit is SystemdUnit => unit !== null);
}

/** Where a unit's Ollama listens, and whether every source of OLLAMA_HOST could be read. */
async function unitHost(unit: SystemdUnit, root: string): Promise<{ listen: OllamaHost; complete: boolean }> {
  let host = unit.environment?.OLLAMA_HOST ?? unit.managerEnvironment?.OLLAMA_HOST;
  let complete = !unit.environmentUnprintable;
  for (const file of unit.environmentFiles) {
    const read = await readUnitFile(join(root, file.path));
    if (!('text' in read)) {
      complete &&= read.missing;
      continue;
    }
    const assigned = parseEnvironmentFile(read.text).findLast(([key]) => key === 'OLLAMA_HOST');
    if (assigned) host = assigned[1];
  }
  return { listen: parseOllamaHost(host), complete };
}

const isSnap = (path: string | null) => path?.startsWith('/snap/') ?? false;

function unitProbe(unit: SystemdUnit, processes: OllamaProcess[]): OllamaInstallProbe {
  const type = isSnap(unit.execPath) ? 'snap' : unit.scope === 'system' ? 'official' : 'user-systemd';
  return {
    install: { type, unit: unit.fragmentPath, binary: unit.execPath },
    unit,
    process: processes.find(p => p.pid === unit.mainPid) ?? null,
  };
}

function processProbe(process: OllamaProcess): OllamaInstallProbe {
  const type = process.containerized ? 'docker' : isSnap(process.exe) ? 'snap' : 'manual';
  return { install: { type, unit: null, binary: process.exe }, unit: null, process };
}

/** How the Ollama at `url` is installed and run, and the unit or process behind it. Never throws. */
export async function detectOllamaInstall(options: OllamaInstallOptions = {}): Promise<OllamaInstallProbe> {
  const url = options.url ?? 'http://127.0.0.1:11434';
  const root = options.rootDir ?? '/';
  const unknown: OllamaInstallProbe = {
    install: { type: 'unknown', unit: null, binary: null },
    unit: null,
    process: null,
  };
  // Nothing seen here serves another machine's address, a wildcard listener included.
  const target = urlTarget(url);
  if (!target) return unknown;
  const local = options.localAddresses ?? localAddresses();
  const resolved = await resolveName(target.host, options.lookup ?? resolveAll);
  if (!isLocalHost(target.host, local) && !anyLocalAddress(resolved, local)) return unknown;

  const [commands, units] = await Promise.all([
    scanProcCommands(root).catch((): ProcCommand[] => []),
    systemdUnits(options.exec ?? defaultExec, options.unitName ?? OLLAMA_UNIT),
  ]);
  const processes = await findOllamaProcesses(root, commands).catch((): OllamaProcess[] => []);
  const listening = processes.filter(
    p => p.env !== null && servesUrl(parseOllamaHost(p.env.OLLAMA_HOST), url, resolved)
  );

  const unmatched: Array<{ unit: SystemdUnit; complete: boolean }> = [];
  for (const unit of units) {
    if (unit.mainPid !== null && listening.some(p => p.pid === unit.mainPid)) return unitProbe(unit, processes);
    const { listen, complete } = await unitHost(unit, root);
    if (servesUrl(listen, url, resolved)) return unitProbe(unit, processes);
    unmatched.push({ unit, complete });
  }
  if (listening[0]) return processProbe(listening[0]);

  // Another user's process hides its environment. Its unit claims it when that unit's OLLAMA_HOST is partly
  // unreadable; one whose host was read in full and listens elsewhere rules it out. A sole remaining one is taken.
  let hidden = processes.filter(p => p.env === null);
  for (const { unit, complete } of unmatched) {
    if (!hidden.some(p => p.pid === unit.mainPid)) continue;
    if (!complete) return unitProbe(unit, processes);
    hidden = hidden.filter(p => p.pid !== unit.mainPid);
  }
  if (hidden.length === 1) return processProbe(hidden[0]);
  if (dockerPublishes(commands, target.port)) {
    return { ...unknown, install: { ...unknown.install, type: 'docker' } };
  }
  return unknown;
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

/**
 * Attributes each allowlisted variable systemd gives the unit to the file that sets it, in systemd's order, or to the
 * service manager's environment when only that sets it.
 */
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
  // The manager's environment sits below every unit's Environment=.
  const values = new Map<string, Attributed>();
  for (const [key, value] of Object.entries(unit.managerEnvironment ?? {})) {
    if (value !== undefined) values.set(key, { value, kind: 'manager', path: null });
  }
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

/**
 * A model host's drop-in only changes a value it would win over: defaults, the manager's environment, the unit and
 * drop-ins sorting before it.
 */
function isWritable(key: OllamaSettingKey, install: OllamaInstall, source: Attributed | null, from: Attribution) {
  if (!WRITABLE.has(key) || (install.type !== 'official' && install.type !== 'user-systemd')) return false;
  if (from.resetAfterHostDropIn || from.unreadableAfterHostDropIn) return false;
  if (!source || source.kind === 'unit' || source.kind === 'manager') return true;
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
