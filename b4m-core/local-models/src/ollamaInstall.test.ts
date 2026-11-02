import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecLike } from './hardware';
import {
  attributeSystemdEnvironment,
  detectOllamaInstall,
  findOllamaProcesses,
  isLocalHost,
  isLocalHostResolved,
  parseEnvironmentFile,
  parseManagerEnvironment,
  parseOllamaHost,
  parseSystemctlShow,
  parseUnitEnvironment,
  readOllamaSettings,
  servesUrl,
  splitSystemctlWords,
  splitSystemdWords,
  type OllamaInstallProbe,
  type SystemdUnit,
} from './ollamaInstall';

const roots: string[] = [];
const unreadable: string[] = [];
afterEach(() => {
  for (const path of unreadable.splice(0)) chmodSync(path, 0o644);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'local-models-ollama-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function lock(root: string, path: string) {
  chmodSync(join(root, path), 0o000);
  unreadable.push(join(root, path));
}

interface ProcFixture {
  pid: number;
  comm: string;
  argv: string[];
  env?: Record<string, string> | null;
  exe?: string;
  cgroup?: string;
}

function proc(root: string, processes: ProcFixture[]) {
  for (const p of processes) {
    const dir = join(root, 'proc', String(p.pid));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'comm'), `${p.comm}\n`);
    writeFileSync(join(dir, 'cmdline'), `${p.argv.join('\0')}\0`);
    writeFileSync(join(dir, 'cgroup'), p.cgroup ?? '0::/user.slice/user-1000.slice/session-3.scope\n');
    if (p.env !== undefined) {
      writeFileSync(
        join(dir, 'environ'),
        Object.entries(p.env ?? {})
          .map(([key, value]) => `${key}=${value}\0`)
          .join('')
      );
      if (p.env === null) lock(root, join('proc', String(p.pid), 'environ'));
    }
    if (p.exe) symlinkSync(p.exe, join(dir, 'exe'));
  }
}

function systemctl(outputs: {
  system?: string;
  user?: string;
  environment?: { system?: string; user?: string };
}): ExecLike {
  return async (command, args) => {
    if (command !== 'systemctl') throw new Error(`unexpected ${command}`);
    const user = args[0] === '--user';
    if (args.includes('show-environment')) {
      return { stdout: (user ? outputs.environment?.user : outputs.environment?.system) ?? '' };
    }
    const output = user ? outputs.user : outputs.system;
    if (output === undefined) throw new Error('Failed to connect to bus');
    return { stdout: output };
  };
}

const NOT_FOUND =
  'LoadState=not-found\nActiveState=inactive\nMainPID=0\nUser=\nFragmentPath=\nDropInPaths=\nEnvironment=\n';

const OFFICIAL_SHOW = [
  'MainPID=812',
  'ExecStart={ path=/usr/local/bin/ollama ; argv[]=/usr/local/bin/ollama serve ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }',
  'Environment="PATH=/usr/local/bin:/usr/bin" OLLAMA_NUM_PARALLEL=2 OLLAMA_CONTEXT_LENGTH=16384 "OLLAMA_ORIGINS=app://* file://*"',
  'EnvironmentFiles=/etc/default/ollama (ignore_errors=yes)',
  'User=ollama',
  'LoadState=loaded',
  'ActiveState=active',
  'FragmentPath=/etc/systemd/system/ollama.service',
  'DropInPaths=/etc/systemd/system/ollama.service.d/50-b4m-host.conf /etc/systemd/system/ollama.service.d/override.conf',
  '',
].join('\n');

// systemd 245 (Ubuntu 20.04) prints list values unquoted and swaps one with a space or newline for [unprintable].
const V245_SHOW = [
  'MainPID=812',
  'Environment=PATH=/usr/local/bin:/usr/bin OLLAMA_NUM_PARALLEL=2 [unprintable]',
  'User=ollama',
  'LoadState=loaded',
  'ActiveState=active',
  'FragmentPath=/etc/systemd/system/ollama.service',
  'DropInPaths=/etc/systemd/system/ollama.service.d/override.conf',
  '',
].join('\n');

const OFFICIAL_UNIT = `[Unit]
Description=Ollama Service
After=network-online.target

[Service]
ExecStart=/usr/local/bin/ollama serve
User=ollama
Group=ollama
Restart=always
RestartSec=3
Environment="PATH=/usr/local/bin:/usr/bin"

[Install]
WantedBy=default.target
`;

describe('splitSystemdWords', () => {
  it('groups quoted words and decodes escapes', () => {
    expect(splitSystemdWords('A=1 "B=two words" C=\'x y\' D=a\\x20b E="q\\"uote"')).toEqual([
      'A=1',
      'B=two words',
      'C=x y',
      'D=a b',
      'E=q"uote',
    ]);
    expect(splitSystemdWords('  ')).toEqual([]);
    expect(splitSystemdWords('F=""')).toEqual(['F=']);
  });

  it('decodes escapes inside single quotes and the octal, \\u and \\U forms, as extract_first_word does', () => {
    expect(splitSystemdWords("A='x\\ty' B=\\101\\x42 C=\\u00e9 D=\\U0001F600 E=a\\sb")).toEqual([
      'A=x\ty',
      'B=AB',
      'C=\xe9',
      'D=\u{1F600}',
      'E=a b',
    ]);
  });

  it('keeps the words before a malformed one and drops the rest, as config_parse_environ does', () => {
    expect(splitSystemdWords('A=1 B=\\q C=3')).toEqual(['A=1']);
    expect(splitSystemdWords('A=1 B=\\x00 C=3')).toEqual(['A=1']);
    expect(splitSystemdWords('A=1 B=\\777')).toEqual(['A=1']);
    expect(splitSystemdWords('A=1 "B=open C=3')).toEqual(['A=1']);
    expect(splitSystemdWords('A=1 B=2\\')).toEqual(['A=1']);
  });
});

describe('splitSystemctlWords', () => {
  it("reads systemctl's shell quoting, with escapes for quotes, dollars, backslashes and control bytes", () => {
    expect(splitSystemctlWords('A=1 "B=two words" "C=q\\"u\\$o\\\\te" "D=a\\nb" "E=\\001" [unprintable]')).toEqual([
      'A=1',
      'B=two words',
      'C=q"u$o\\te',
      'D=a\nb',
      'E=\x01',
      '[unprintable]',
    ]);
  });
});

describe('parseUnitEnvironment', () => {
  it('skips comment lines inside a continuation and continues only on an odd run of trailing backslashes', () => {
    expect(
      parseUnitEnvironment(
        '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=2 \\\n# note\n  ; other\n  OLLAMA_KEEP_ALIVE=10m\nEnvironment=OLLAMA_HOST=a\\\\\nEnvironment=OLLAMA_MODELS=b \\ \nEnvironment=OLLAMA_ORIGINS=c\\\\\\\n  OLLAMA_CONTEXT_LENGTH=8192'
      )
    ).toEqual([
      { kind: 'set', key: 'OLLAMA_NUM_PARALLEL', value: '2' },
      { kind: 'set', key: 'OLLAMA_KEEP_ALIVE', value: '10m' },
      { kind: 'set', key: 'OLLAMA_HOST', value: 'a\\' },
      { kind: 'set', key: 'OLLAMA_MODELS', value: 'b' },
      { kind: 'set', key: 'OLLAMA_ORIGINS', value: 'c\\' },
      { kind: 'set', key: 'OLLAMA_CONTEXT_LENGTH', value: '8192' },
    ]);
  });

  it('holds allowlisted variables only', () => {
    expect(
      parseUnitEnvironment(
        '[Service]\nEnvironment="OLLAMA_API_KEY=sk-x" PATH=/usr/bin HTTPS_PROXY=http://u:p@proxy HOME=/srv OLLAMA_GPU_OVERHEAD=1\n'
      )
    ).toEqual([
      { kind: 'set', key: 'HOME', value: '/srv' },
      { kind: 'set', key: 'OLLAMA_GPU_OVERHEAD', value: '1' },
    ]);
  });

  it('reads Environment= in [Service] only, with continuations, comments and resets', () => {
    const events = parseUnitEnvironment(`[Unit]
Environment=OLLAMA_HOST=0.0.0.0
[Service]
# Environment=OLLAMA_NUM_PARALLEL=9
; Environment=OLLAMA_NUM_PARALLEL=8
Environment=OLLAMA_NUM_PARALLEL=2 \\
  OLLAMA_KEEP_ALIVE=10m
Environment = "OLLAMA_ORIGINS=a b" not-an-assignment 1BAD=x
Environment=
Environment=OLLAMA_FLASH_ATTENTION=1
`);
    expect(events).toEqual([
      { kind: 'set', key: 'OLLAMA_NUM_PARALLEL', value: '2' },
      { kind: 'set', key: 'OLLAMA_KEEP_ALIVE', value: '10m' },
      { kind: 'set', key: 'OLLAMA_ORIGINS', value: 'a b' },
      { kind: 'reset' },
      { kind: 'set', key: 'OLLAMA_FLASH_ATTENTION', value: '1' },
    ]);
  });
});

describe('parseEnvironmentFile', () => {
  it('reads assignments and skips comments and malformed lines', () => {
    expect(
      parseEnvironmentFile(
        '# comment\n; also\nOLLAMA_KV_CACHE_TYPE=q8_0\nOLLAMA_ORIGINS="a \\"b\\""\nOLLAMA_HOST=\'0.0.0.0\'\nnot a line\n=x\n'
      )
    ).toEqual([
      ['OLLAMA_KV_CACHE_TYPE', 'q8_0'],
      ['OLLAMA_ORIGINS', 'a "b"'],
      ['OLLAMA_HOST', '0.0.0.0'],
    ]);
    expect(parseEnvironmentFile('OLLAMA_API_KEY=sk-x\nhttp_proxy=http://u:p@proxy\nHOME=/srv\n')).toEqual([
      ['HOME', '/srv'],
    ]);
  });

  it.each([
    ['a quote opening mid-value', 'OLLAMA_HOST="0.0.0.0":11500', '0.0.0.0:11500'],
    ['an unquoted backslash escape', 'OLLAMA_MODELS=/data/my\\ models', '/data/my models'],
    ['a backslash-newline in single quotes, literally', "OLLAMA_ORIGINS='a\\\nb'", 'a\\\nb'],
    ['an unquoted continuation', 'OLLAMA_ORIGINS=a\\\nb', 'ab'],
    ['an escape double quotes do not need, backslash kept', 'OLLAMA_ORIGINS="a\\nb"', 'a\\nb'],
    ['a continuation inside double quotes', 'OLLAMA_ORIGINS="a\\\nb"', 'ab'],
    ['trailing whitespace, chomped', 'OLLAMA_KEEP_ALIVE=10m  \t', '10m'],
    ['a # mid-value, kept', 'OLLAMA_NUM_PARALLEL=4 # four', '4 # four'],
    ['whitespace around the key and before the value', '  OLLAMA_KEEP_ALIVE =  1h', '1h'],
    ['quoted whitespace, kept', 'OLLAMA_ORIGINS=" a "', ' a '],
    ['an empty value', 'OLLAMA_ORIGINS=', ''],
    ['a CRLF line end', 'OLLAMA_KEEP_ALIVE=1h\r\n', '1h'],
  ])('reads %s as systemd does', (_, text, value) => {
    expect(parseEnvironmentFile(text)).toEqual([[text.trim().split(/\s*=/)[0], value]]);
  });

  it('drops an export prefix, which systemd reads as part of an invalid name', () => {
    expect(parseEnvironmentFile('export OLLAMA_HOST=0.0.0.0\nOLLAMA_KEEP_ALIVE=1h\n')).toEqual([
      ['OLLAMA_KEEP_ALIVE', '1h'],
    ]);
  });

  it('reads the line after a comment ending in a backslash, as systemd 254 and later do', () => {
    expect(parseEnvironmentFile('# note \\\nOLLAMA_KEEP_ALIVE=1h\n')).toEqual([['OLLAMA_KEEP_ALIVE', '1h']]);
  });
});

describe('parseManagerEnvironment', () => {
  it("reads show-environment's plain and $'...' values, keeping allowlisted variables only", () => {
    expect(
      parseManagerEnvironment(
        "LANG=C.UTF-8\nPATH=/usr/bin\nOLLAMA_MODELS=$'/data/my models'\nOLLAMA_ORIGINS=$'a\\'b\\\\c\\nd'\nOLLAMA_HOST=$'bad\\q'\nOLLAMA_KEEP_ALIVE=1h\n"
      )
    ).toEqual({ OLLAMA_MODELS: '/data/my models', OLLAMA_ORIGINS: "a'b\\c\nd", OLLAMA_KEEP_ALIVE: '1h' });
  });
});

describe('parseSystemctlShow', () => {
  it('reads the unit, its drop-ins, environment and environment files', () => {
    expect(parseSystemctlShow(OFFICIAL_SHOW, 'system')).toEqual({
      scope: 'system',
      loadState: 'loaded',
      activeState: 'active',
      mainPid: 812,
      user: 'ollama',
      execPath: '/usr/local/bin/ollama',
      fragmentPath: '/etc/systemd/system/ollama.service',
      dropInPaths: [
        '/etc/systemd/system/ollama.service.d/50-b4m-host.conf',
        '/etc/systemd/system/ollama.service.d/override.conf',
      ],
      environmentFiles: [{ path: '/etc/default/ollama', optional: true }],
      environment: {
        OLLAMA_NUM_PARALLEL: '2',
        OLLAMA_CONTEXT_LENGTH: '16384',
        OLLAMA_ORIGINS: 'app://* file://*',
      },
      environmentUnprintable: false,
    });
  });

  it("flags systemd 245's [unprintable] stand-in for a value with a space", () => {
    const unit = parseSystemctlShow(V245_SHOW, 'system');
    expect(unit.environment).toEqual({ OLLAMA_NUM_PARALLEL: '2' });
    expect(unit.environmentUnprintable).toBe(true);
  });

  it('reads an absent unit as not loaded with empty fields', () => {
    expect(parseSystemctlShow(NOT_FOUND, 'user')).toMatchObject({
      loadState: 'not-found',
      mainPid: null,
      user: null,
      fragmentPath: null,
      dropInPaths: [],
      environment: {},
    });
  });
});

describe('parseOllamaHost and servesUrl', () => {
  it('reads OLLAMA_HOST as Ollama does', () => {
    expect(parseOllamaHost(undefined)).toEqual({ host: '127.0.0.1', port: 11434 });
    expect(parseOllamaHost('0.0.0.0')).toEqual({ host: '0.0.0.0', port: 11434 });
    expect(parseOllamaHost(':11435')).toEqual({ host: '', port: 11435 });
    expect(parseOllamaHost('"127.0.0.1:11446"')).toEqual({ host: '127.0.0.1', port: 11446 });
    expect(parseOllamaHost('http://10.0.0.5')).toEqual({ host: '10.0.0.5', port: 80 });
    expect(parseOllamaHost('[::1]:11500')).toEqual({ host: '::1', port: 11500 });
    expect(parseOllamaHost('::1')).toEqual({ host: '::1', port: 11434 });
    expect(parseOllamaHost('127.0.0.1:99999')).toEqual({ host: '127.0.0.1', port: 11434 });
  });

  it('matches localhost to 127.0.0.1, wildcard listeners, and otherwise the exact host and port', () => {
    expect(servesUrl({ host: '127.0.0.1', port: 11434 }, 'http://localhost:11434')).toBe(true);
    expect(servesUrl({ host: 'localhost', port: 11434 }, 'http://127.0.0.1:11434')).toBe(true);
    expect(servesUrl({ host: '0.0.0.0', port: 11434 }, 'http://127.0.0.1:11434')).toBe(true);
    expect(servesUrl({ host: '::1', port: 11434 }, 'http://[::1]:11434')).toBe(true);
    expect(servesUrl({ host: '::1', port: 11434 }, 'http://127.0.0.1:11434')).toBe(false);
    expect(servesUrl({ host: '127.0.0.2', port: 11434 }, 'http://127.0.0.1:11434')).toBe(false);
    expect(servesUrl({ host: '127.0.0.1', port: 11434 }, 'http://127.0.0.1:11446')).toBe(false);
    expect(servesUrl({ host: '10.0.0.5', port: 11434 }, 'http://127.0.0.1:11434')).toBe(false);
    expect(servesUrl({ host: '10.0.0.5', port: 443 }, 'https://10.0.0.5')).toBe(true);
    expect(servesUrl({ host: '127.0.0.1', port: 11434 }, 'not a url')).toBe(false);
  });
});

describe('findOllamaProcesses', () => {
  it('lists serve processes with their Ollama variables, skipping runners and other commands', async () => {
    const root = tree({});
    proc(root, [
      {
        pid: 100,
        comm: 'ollama',
        argv: ['/opt/ollama/bin/ollama', 'serve'],
        env: {
          OLLAMA_HOST: '127.0.0.1:11446',
          HOME: '/home/me',
          SECRET_TOKEN: 'x',
          PATH: '/usr/bin',
          OLLAMA_API_KEY: 'sk-x',
          HTTPS_PROXY: 'http://user:pass@proxy:3128',
        },
        exe: '/opt/ollama/bin/ollama',
      },
      { pid: 101, comm: 'ollama', argv: ['/opt/ollama/bin/ollama', 'runner', '--model', 'x'], env: {} },
      { pid: 102, comm: 'bash', argv: ['bash'], env: {} },
    ]);
    expect(await findOllamaProcesses(root)).toEqual([
      {
        pid: 100,
        argv: ['/opt/ollama/bin/ollama', 'serve'],
        exe: '/opt/ollama/bin/ollama',
        env: { OLLAMA_HOST: '127.0.0.1:11446', HOME: '/home/me' },
        containerized: false,
      },
    ]);
  });

  it('returns nothing without /proc', async () => {
    expect(await findOllamaProcesses(join(tree({}), 'missing'))).toEqual([]);
  });
});

describe('isLocalHost', () => {
  it('takes loopback, wildcards and the given addresses and names as this machine', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      '127.0.0.1',
      '127.1.2.3',
      '::1',
      '0.0.0.0',
      '::',
      '10.0.0.5',
      'box',
    ]) {
      expect(isLocalHost(host, ['10.0.0.5', 'box'])).toBe(true);
    }
    for (const host of ['10.0.0.6', 'ollama.lan', '128.0.0.1', '::2']) {
      expect(isLocalHost(host, ['10.0.0.5', 'box'])).toBe(false);
    }
  });

  it('unwraps an IPv4-mapped IPv6 address, as URL parsing writes it', () => {
    expect(new URL('http://[::ffff:127.0.0.1]:11434').hostname).toBe('[::ffff:7f00:1]');
    for (const host of ['::ffff:7f00:1', '::ffff:127.0.0.1', '::ffff:a00:5']) {
      expect(isLocalHost(host, ['10.0.0.5'])).toBe(true);
    }
    expect(isLocalHost('::ffff:a00:6', ['10.0.0.5'])).toBe(false);
  });
});

describe('isLocalHostResolved', () => {
  const local = ['10.0.0.5', 'box'];

  it('takes a name that resolves to loopback or one of this machine addresses as local', async () => {
    expect(await isLocalHostResolved('box.lan', local, async () => ['10.0.0.5'])).toBe(true);
    expect(await isLocalHostResolved('box.local', local, async () => ['192.0.2.9', '::1'])).toBe(true);
    expect(await isLocalHostResolved('box.lan', local, async () => ['192.0.2.9'])).toBe(false);
  });

  it('keeps an unresolvable name, and a name that resolves to a wildcard, non-local', async () => {
    expect(await isLocalHostResolved('gone.lan', local, async () => Promise.reject(new Error('ENOTFOUND')))).toBe(
      false
    );
    expect(await isLocalHostResolved('gone.lan', local, async () => [])).toBe(false);
    expect(await isLocalHostResolved('any.lan', local, async () => ['0.0.0.0'])).toBe(false);
  });

  it('does not look up an IP literal', async () => {
    const resolve = vi.fn(async () => ['127.0.0.1']);
    expect(await isLocalHostResolved('10.0.0.6', local, resolve)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('detectOllamaInstall', () => {
  const url = 'http://127.0.0.1:11434';

  it('finds the official system unit even when its process belongs to another user', async () => {
    const root = tree({});
    proc(root, [{ pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: null }]);
    const probe = await detectOllamaInstall({ url, rootDir: root, exec: systemctl({ system: OFFICIAL_SHOW }) });
    expect(probe.install).toEqual({
      type: 'official',
      unit: '/etc/systemd/system/ollama.service',
      binary: '/usr/local/bin/ollama',
    });
    expect(probe.process?.pid).toBe(812);
  });

  it('finds a systemctl --user unit', async () => {
    const show = OFFICIAL_SHOW.replace('User=ollama', 'User=').replace(
      'FragmentPath=/etc/systemd/system/ollama.service',
      'FragmentPath=/home/me/.config/systemd/user/ollama.service'
    );
    const probe = await detectOllamaInstall({
      url,
      rootDir: tree({}),
      exec: systemctl({ system: NOT_FOUND, user: show }),
    });
    expect(probe.install.type).toBe('user-systemd');
    expect(probe.unit?.scope).toBe('user');
  });

  it('skips a unit that listens on another port, as set in its environment file', async () => {
    const root = tree({ 'etc/default/ollama': 'OLLAMA_HOST=127.0.0.1:11500\n' });
    proc(root, [
      {
        pid: 900,
        comm: 'ollama',
        argv: ['/home/me/ollama/bin/ollama', 'serve'],
        env: { OLLAMA_MODELS: '/data/models' },
        exe: '/home/me/ollama/bin/ollama',
      },
    ]);
    const probe = await detectOllamaInstall({ url, rootDir: root, exec: systemctl({ system: OFFICIAL_SHOW }) });
    expect(probe.install).toEqual({ type: 'manual', unit: null, binary: '/home/me/ollama/bin/ollama' });
    expect(probe.process?.pid).toBe(900);
  });

  it('picks the process listening on the probed port among several', async () => {
    const root = tree({});
    proc(root, [
      { pid: 10, comm: 'ollama', argv: ['ollama', 'serve'], env: { OLLAMA_HOST: '127.0.0.1:11434' } },
      { pid: 11, comm: 'ollama', argv: ['ollama', 'serve'], env: { OLLAMA_HOST: '127.0.0.1:11446' } },
    ]);
    const exec = systemctl({ system: NOT_FOUND, user: NOT_FOUND });
    expect((await detectOllamaInstall({ url: 'http://127.0.0.1:11446', rootDir: root, exec })).process?.pid).toBe(11);
    expect((await detectOllamaInstall({ url, rootDir: root, exec })).process?.pid).toBe(10);
  });

  it('labels a containerized process docker and a /snap binary snap', async () => {
    const docker = tree({});
    proc(docker, [
      {
        pid: 20,
        comm: 'ollama',
        argv: ['/bin/ollama', 'serve'],
        env: { OLLAMA_HOST: '0.0.0.0' },
        cgroup: '0::/system.slice/docker-0123abcd.scope\n',
      },
    ]);
    expect((await detectOllamaInstall({ url, rootDir: docker, exec: systemctl({}) })).install.type).toBe('docker');

    const snap = tree({});
    proc(snap, [{ pid: 30, comm: 'ollama', argv: ['/snap/ollama/12/bin/ollama', 'serve'], env: null }]);
    expect((await detectOllamaInstall({ url, rootDir: snap, exec: systemctl({}) })).install).toEqual({
      type: 'snap',
      unit: null,
      binary: '/snap/ollama/12/bin/ollama',
    });
  });

  it('falls back to Docker port publishing, then unknown', async () => {
    const root = tree({});
    proc(root, [
      {
        pid: 40,
        comm: 'docker-proxy',
        argv: ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '11434'],
      },
    ]);
    expect((await detectOllamaInstall({ url, rootDir: root, exec: systemctl({}) })).install.type).toBe('docker');
    expect((await detectOllamaInstall({ url, rootDir: tree({}), exec: systemctl({}) })).install).toEqual({
      type: 'unknown',
      unit: null,
      binary: null,
    });
  });

  it('never throws on a bad URL and defaults the port by protocol', async () => {
    const root = tree({});
    proc(root, [
      {
        pid: 41,
        comm: 'docker-proxy',
        argv: ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '443'],
      },
    ]);
    const exec = systemctl({});
    expect((await detectOllamaInstall({ url: 'not a url', rootDir: root, exec })).install.type).toBe('unknown');
    expect((await detectOllamaInstall({ url: 'https://localhost', rootDir: root, exec })).install.type).toBe('docker');
  });

  it('lets a unit whose environment file it cannot read claim its hidden process', async () => {
    const root = tree({ 'etc/default/ollama': 'OLLAMA_HOST=127.0.0.1:11500\n' });
    lock(root, 'etc/default/ollama');
    proc(root, [{ pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: null }]);
    const exec = systemctl({ system: OFFICIAL_SHOW });
    const probe = await detectOllamaInstall({ url: 'http://127.0.0.1:11500', rootDir: root, exec });
    expect(probe.install).toEqual({
      type: 'official',
      unit: '/etc/systemd/system/ollama.service',
      binary: '/usr/local/bin/ollama',
    });
    expect(probe.process?.pid).toBe(812);
  });

  it('rules out a hidden process whose unit was read in full and listens elsewhere', async () => {
    const root = tree({ 'etc/default/ollama': 'OLLAMA_HOST=127.0.0.1:11500\n' });
    proc(root, [{ pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: null }]);
    const probe = await detectOllamaInstall({ url, rootDir: root, exec: systemctl({ system: OFFICIAL_SHOW }) });
    expect(probe).toEqual({ install: { type: 'unknown', unit: null, binary: null }, unit: null, process: null });
  });

  it('attributes no hidden process or Docker proxy here to a URL on another machine', async () => {
    const root = tree({});
    proc(root, [
      { pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: null },
      {
        pid: 40,
        comm: 'docker-proxy',
        argv: ['/usr/bin/docker-proxy', '-proto', 'tcp', '-host-ip', '0.0.0.0', '-host-port', '11434'],
      },
    ]);
    const remote = 'http://10.0.0.5:11434';
    const localAddresses = ['127.0.0.1', '192.168.1.20', 'workstation'];
    for (const exec of [systemctl({ system: OFFICIAL_SHOW }), systemctl({})]) {
      expect((await detectOllamaInstall({ url: remote, rootDir: root, exec, localAddresses })).install).toEqual({
        type: 'unknown',
        unit: null,
        binary: null,
      });
    }
    const here = await detectOllamaInstall({
      url: remote,
      rootDir: root,
      exec: systemctl({}),
      localAddresses: ['10.0.0.5'],
    });
    expect(here.install).toEqual({ type: 'manual', unit: null, binary: '/usr/local/bin/ollama' });
  });

  it('attributes no wildcard unit or process here to a URL on another machine', async () => {
    const root = tree({});
    proc(root, [
      { pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: { OLLAMA_HOST: '0.0.0.0:11434' } },
    ]);
    const show = OFFICIAL_SHOW.replace(/^Environment=.*$/m, 'Environment=OLLAMA_HOST=0.0.0.0:11434');
    const remote = 'http://10.0.0.5:11434';
    const localAddresses = ['127.0.0.1', '192.168.1.20'];
    for (const exec of [systemctl({ system: show }), systemctl({})]) {
      expect(await detectOllamaInstall({ url: remote, rootDir: root, exec, localAddresses })).toEqual({
        install: { type: 'unknown', unit: null, binary: null },
        unit: null,
        process: null,
      });
    }
    const here = await detectOllamaInstall({
      url: remote,
      rootDir: root,
      exec: systemctl({ system: show }),
      localAddresses: ['10.0.0.5'],
    });
    expect(here.install.type).toBe('official');
  });

  it('detects the install for a URL naming this machine by FQDN or mapped loopback, not for an unresolvable name', async () => {
    const root = tree({});
    proc(root, [{ pid: 812, comm: 'ollama', argv: ['/usr/local/bin/ollama', 'serve'], env: null }]);
    const base = { rootDir: root, exec: systemctl({}), localAddresses: ['192.168.1.20', 'box'] };
    const manual = { type: 'manual', unit: null, binary: '/usr/local/bin/ollama' };
    const fqdn = await detectOllamaInstall({
      ...base,
      url: 'http://box.lan:11434',
      lookup: async () => ['192.168.1.20'],
    });
    expect(fqdn.install).toEqual(manual);
    const mapped = await detectOllamaInstall({ ...base, url: 'http://[::ffff:127.0.0.1]:11434' });
    expect(mapped.install).toEqual(manual);
    const gone = await detectOllamaInstall({
      ...base,
      url: 'http://gone.lan:11434',
      lookup: async () => Promise.reject(new Error('ENOTFOUND')),
    });
    expect(gone.install.type).toBe('unknown');
  });

  it("reads the service manager's environment for an active unit, OLLAMA_HOST included", async () => {
    const exec = systemctl({
      system: OFFICIAL_SHOW,
      environment: { system: "LANG=C.UTF-8\nOLLAMA_HOST=127.0.0.1:11600\nOLLAMA_MODELS=$'/data/my models'\n" },
    });
    const probe = await detectOllamaInstall({ url: 'http://127.0.0.1:11600', rootDir: tree({}), exec });
    expect(probe.install.type).toBe('official');
    expect(probe.unit?.managerEnvironment).toEqual({
      OLLAMA_HOST: '127.0.0.1:11600',
      OLLAMA_MODELS: '/data/my models',
    });
  });

  it('passes the unit name after -- and refuses names that are not plain .service units', async () => {
    const calls: string[][] = [];
    const exec: ExecLike = async (command, args) => {
      calls.push(args);
      return { stdout: NOT_FOUND };
    };
    await detectOllamaInstall({ url, rootDir: tree({}), exec, unitName: 'ollama@gpu0.service' });
    expect(calls.map(args => args.slice(-2))).toEqual([
      ['--', 'ollama@gpu0.service'],
      ['--', 'ollama@gpu0.service'],
    ]);
    expect(calls[1][0]).toBe('--user');
    calls.length = 0;
    for (const unitName of ['--help.service', 'ollama', 'a b.service', '../x.service/', 'x.socket']) {
      await detectOllamaInstall({ url, rootDir: tree({}), exec, unitName });
    }
    expect(calls).toEqual([]);
  });
});

function unitFrom(show: string): SystemdUnit {
  return parseSystemctlShow(show, 'system');
}

const officialFiles = {
  'etc/systemd/system/ollama.service': OFFICIAL_UNIT,
  'etc/systemd/system/ollama.service.d/50-b4m-host.conf':
    '[Service]\nEnvironment="OLLAMA_NUM_PARALLEL=4"\nEnvironment="OLLAMA_CONTEXT_LENGTH=8192"\n',
  'etc/systemd/system/ollama.service.d/override.conf':
    '[Service]\nEnvironment="OLLAMA_CONTEXT_LENGTH=16384"\nEnvironment="OLLAMA_NUM_PARALLEL=2"\nEnvironment="OLLAMA_ORIGINS=app://* file://*"\n',
  'etc/default/ollama': 'OLLAMA_KV_CACHE_TYPE=q8_0\n',
};

describe('attributeSystemdEnvironment', () => {
  it('attributes each value to the last file that sets it, environment files last', async () => {
    const attribution = await attributeSystemdEnvironment(unitFrom(OFFICIAL_SHOW), tree(officialFiles));
    const { values, unreadablePaths } = attribution;
    expect(unreadablePaths).toEqual([]);
    expect(attribution).toMatchObject({ resetAfterHostDropIn: false, unreadableAfterHostDropIn: false });
    expect(Object.fromEntries(values)).toEqual({
      OLLAMA_NUM_PARALLEL: {
        value: '2',
        kind: 'override',
        path: '/etc/systemd/system/ollama.service.d/override.conf',
      },
      OLLAMA_CONTEXT_LENGTH: {
        value: '16384',
        kind: 'override',
        path: '/etc/systemd/system/ollama.service.d/override.conf',
      },
      OLLAMA_ORIGINS: {
        value: 'app://* file://*',
        kind: 'override',
        path: '/etc/systemd/system/ollama.service.d/override.conf',
      },
      OLLAMA_KV_CACHE_TYPE: { value: 'q8_0', kind: 'env-file', path: '/etc/default/ollama' },
    });
  });

  it('reports unreadable files and leaves values it cannot place unattributed', async () => {
    const root = tree(officialFiles);
    lock(root, 'etc/systemd/system/ollama.service.d/override.conf');
    lock(root, 'etc/default/ollama');
    const { values, unreadablePaths } = await attributeSystemdEnvironment(unitFrom(OFFICIAL_SHOW), root);
    expect(unreadablePaths).toEqual(['/etc/systemd/system/ollama.service.d/override.conf', '/etc/default/ollama']);
    expect(values.get('OLLAMA_NUM_PARALLEL')).toEqual({ value: '2', kind: 'unattributed', path: null });
    expect(values.get('OLLAMA_ORIGINS')).toEqual({ value: 'app://* file://*', kind: 'unattributed', path: null });
    expect(values.has('PATH')).toBe(false);
    expect(values.has('OLLAMA_KV_CACHE_TYPE')).toBe(false);
  });

  it('skips missing files and parses the files when systemd reports no environment', async () => {
    const show = OFFICIAL_SHOW.split('\n')
      .filter(line => !line.startsWith('Environment='))
      .join('\n');
    const root = tree({
      'etc/systemd/system/ollama.service': OFFICIAL_UNIT.replace(
        'Environment="PATH=/usr/local/bin:/usr/bin"',
        'Environment="PATH=/usr/local/bin:/usr/bin" OLLAMA_MAX_LOADED_MODELS=3'
      ),
    });
    const { values, unreadablePaths } = await attributeSystemdEnvironment(unitFrom(show), root);
    expect(unreadablePaths).toEqual([]);
    expect([...values.keys()]).toEqual(['OLLAMA_MAX_LOADED_MODELS']);
  });

  it('drops values an empty Environment= reset clears, and flags a reset sorting after the model host drop-in', async () => {
    const root = tree({
      ...officialFiles,
      'etc/systemd/system/ollama.service.d/override.conf':
        '[Service]\nEnvironment=\nEnvironment=OLLAMA_KEEP_ALIVE=1h\n',
    });
    const show = OFFICIAL_SHOW.split('\n')
      .filter(line => !line.startsWith('Environment='))
      .join('\n');
    const { values, resetAfterHostDropIn } = await attributeSystemdEnvironment(unitFrom(show), root);
    expect(values.get('OLLAMA_KEEP_ALIVE')?.kind).toBe('override');
    expect(values.has('OLLAMA_NUM_PARALLEL')).toBe(false);
    expect(resetAfterHostDropIn).toBe(true);

    const early = tree({
      ...officialFiles,
      'etc/systemd/system/ollama.service.d/10-early.conf': '[Service]\nEnvironment=\n',
    });
    const earlyShow = OFFICIAL_SHOW.replace(
      /^DropInPaths=/m,
      'DropInPaths=/etc/systemd/system/ollama.service.d/10-early.conf '
    );
    expect((await attributeSystemdEnvironment(unitFrom(earlyShow), early)).resetAfterHostDropIn).toBe(false);
  });

  it('flags an unreadable drop-in only when it sorts after the model host drop-in, and any unreadable env file', async () => {
    const show = OFFICIAL_SHOW.replace(
      /^DropInPaths=.*$/m,
      'DropInPaths=/etc/systemd/system/ollama.service.d/10-a.conf /etc/systemd/system/ollama.service.d/50-b4m-host.conf /etc/systemd/system/ollama.service.d/60-b.conf'
    ).replace(/^EnvironmentFiles=.*$/m, '');
    const files = {
      'etc/systemd/system/ollama.service': OFFICIAL_UNIT,
      'etc/systemd/system/ollama.service.d/10-a.conf': '[Service]\n',
      'etc/systemd/system/ollama.service.d/50-b4m-host.conf':
        officialFiles['etc/systemd/system/ollama.service.d/50-b4m-host.conf'],
      'etc/systemd/system/ollama.service.d/60-b.conf': '[Service]\n',
      'etc/default/ollama': 'OLLAMA_KV_CACHE_TYPE=q8_0\n',
    };
    const early = tree(files);
    lock(early, 'etc/systemd/system/ollama.service.d/10-a.conf');
    expect(await attributeSystemdEnvironment(unitFrom(show), early)).toMatchObject({
      unreadablePaths: ['/etc/systemd/system/ollama.service.d/10-a.conf'],
      unreadableAfterHostDropIn: false,
    });
    const late = tree(files);
    lock(late, 'etc/systemd/system/ollama.service.d/60-b.conf');
    expect((await attributeSystemdEnvironment(unitFrom(show), late)).unreadableAfterHostDropIn).toBe(true);
    const envFile = tree(files);
    lock(envFile, 'etc/default/ollama');
    const withEnvFile = `${show}\nEnvironmentFiles=/etc/default/ollama (ignore_errors=yes)\n`;
    expect((await attributeSystemdEnvironment(unitFrom(withEnvFile), envFile)).unreadableAfterHostDropIn).toBe(true);
  });

  it('restores a value systemd 245 hid behind [unprintable] from the readable files', async () => {
    const root = tree({
      'etc/systemd/system/ollama.service': OFFICIAL_UNIT,
      'etc/systemd/system/ollama.service.d/override.conf':
        '[Service]\nEnvironment=OLLAMA_NUM_PARALLEL=2 "OLLAMA_MODELS=/mnt/my models"\n',
    });
    const { values } = await attributeSystemdEnvironment(unitFrom(V245_SHOW), root);
    expect(values.get('OLLAMA_MODELS')).toEqual({
      value: '/mnt/my models',
      kind: 'override',
      path: '/etc/systemd/system/ollama.service.d/override.conf',
    });
    expect(values.get('OLLAMA_NUM_PARALLEL')?.kind).toBe('override');

    const printable = V245_SHOW.replace(' [unprintable]', '');
    expect((await attributeSystemdEnvironment(unitFrom(printable), root)).values.has('OLLAMA_MODELS')).toBe(false);
  });
});

describe('readOllamaSettings', () => {
  const official = (show = OFFICIAL_SHOW): OllamaInstallProbe => ({
    install: { type: 'official', unit: '/etc/systemd/system/ollama.service', binary: '/usr/local/bin/ollama' },
    unit: unitFrom(show),
    process: null,
  });

  it('marks override.conf and environment-file values read-only, the rest writable by allowlist', async () => {
    const files = {
      ...officialFiles,
      'etc/systemd/system/ollama.service.d/override.conf': '[Service]\nEnvironment="OLLAMA_ORIGINS=app://* file://*"\n',
    };
    const show = OFFICIAL_SHOW.replace(
      /^Environment=.*$/m,
      'Environment="PATH=/usr/local/bin:/usr/bin" OLLAMA_NUM_PARALLEL=4 OLLAMA_CONTEXT_LENGTH=8192 "OLLAMA_ORIGINS=app://* file://*"'
    );
    const { settings, env } = await readOllamaSettings(official(show), { rootDir: tree(files) });
    const byKey = Object.fromEntries(settings.settings.map(s => [s.key, s]));
    expect(settings.readable).toBe(true);
    expect(byKey.OLLAMA_NUM_PARALLEL).toEqual({
      key: 'OLLAMA_NUM_PARALLEL',
      value: '4',
      source: { kind: 'dropin', path: '/etc/systemd/system/ollama.service.d/50-b4m-host.conf' },
      writable: true,
    });
    expect(byKey.OLLAMA_ORIGINS).toMatchObject({ source: { kind: 'override' }, writable: false });
    expect(byKey.OLLAMA_KV_CACHE_TYPE).toMatchObject({ value: 'q8_0', source: { kind: 'env-file' }, writable: false });
    expect(byKey.OLLAMA_KEEP_ALIVE).toEqual({
      key: 'OLLAMA_KEEP_ALIVE',
      value: '5m',
      source: { kind: 'default', path: null },
      writable: true,
    });
    expect(byKey.OLLAMA_CONTEXT_LENGTH.writable).toBe(true);
    expect(byKey.OLLAMA_MODELS).toMatchObject({ value: null, writable: false });
    expect(env).toEqual({
      OLLAMA_NUM_PARALLEL: '4',
      OLLAMA_CONTEXT_LENGTH: '8192',
      OLLAMA_ORIGINS: 'app://* file://*',
      OLLAMA_KV_CACHE_TYPE: 'q8_0',
    });
  });

  it('keeps a value from a drop-in that sorts after the model host drop-in read-only', async () => {
    const show = OFFICIAL_SHOW.replace(
      /^DropInPaths=.*$/m,
      'DropInPaths=/etc/systemd/system/ollama.service.d/60-gpu.conf'
    ).replace(/^Environment=.*$/m, 'Environment=OLLAMA_FLASH_ATTENTION=1');
    const root = tree({
      'etc/systemd/system/ollama.service': OFFICIAL_UNIT,
      'etc/systemd/system/ollama.service.d/60-gpu.conf': '[Service]\nEnvironment=OLLAMA_FLASH_ATTENTION=1\n',
    });
    const { settings } = await readOllamaSettings(official(show), { rootDir: root });
    expect(settings.settings.find(s => s.key === 'OLLAMA_FLASH_ATTENTION')).toMatchObject({
      value: '1',
      source: { kind: 'dropin' },
      writable: false,
    });
  });

  it('makes nothing writable when a later drop-in resets the environment or cannot be read', async () => {
    const reset = tree({
      ...officialFiles,
      'etc/systemd/system/ollama.service.d/90-reset.conf': '[Service]\nEnvironment=\nEnvironment=OLLAMA_HOST=0.0.0.0\n',
    });
    const show = OFFICIAL_SHOW.replace(
      /^DropInPaths=.*$/m,
      'DropInPaths=/etc/systemd/system/ollama.service.d/50-b4m-host.conf /etc/systemd/system/ollama.service.d/90-reset.conf'
    ).replace(/^Environment=.*$/m, 'Environment=OLLAMA_HOST=0.0.0.0');
    const afterReset = await readOllamaSettings(official(show), { rootDir: reset });
    expect(afterReset.settings.settings.filter(s => s.writable)).toEqual([]);
    expect(afterReset.settings.settings.find(s => s.key === 'OLLAMA_NUM_PARALLEL')).toMatchObject({
      value: '1',
      source: { kind: 'default' },
    });

    const locked = tree(officialFiles);
    lock(locked, 'etc/systemd/system/ollama.service.d/override.conf');
    const behindLock = await readOllamaSettings(official(), { rootDir: locked });
    expect(behindLock.settings.settings.filter(s => s.writable)).toEqual([]);
  });

  it("takes a unit's values from its running process and marks the ones its files have since changed", async () => {
    const root = tree(officialFiles);
    const probe: OllamaInstallProbe = {
      ...official(),
      process: {
        pid: 812,
        argv: ['/usr/local/bin/ollama', 'serve'],
        exe: '/usr/local/bin/ollama',
        env: { OLLAMA_NUM_PARALLEL: '2', OLLAMA_CONTEXT_LENGTH: '4096', OLLAMA_KEEP_ALIVE: '1h', HOME: '/srv/ollama' },
        containerized: false,
      },
    };
    const { settings, env } = await readOllamaSettings(probe, { rootDir: root });
    const byKey = Object.fromEntries(settings.settings.map(s => [s.key, s]));
    expect(byKey.OLLAMA_NUM_PARALLEL).toEqual({
      key: 'OLLAMA_NUM_PARALLEL',
      value: '2',
      source: { kind: 'override', path: '/etc/systemd/system/ollama.service.d/override.conf' },
      writable: false,
    });
    expect(byKey.OLLAMA_CONTEXT_LENGTH).toEqual({
      key: 'OLLAMA_CONTEXT_LENGTH',
      value: '4096',
      source: { kind: 'process', path: '/proc/812/environ' },
      writable: false,
      pendingRestart: true,
    });
    expect(byKey.OLLAMA_KEEP_ALIVE).toMatchObject({ value: '1h', source: { kind: 'process' }, pendingRestart: true });
    expect(byKey.OLLAMA_KV_CACHE_TYPE).toMatchObject({
      value: 'f16',
      source: { kind: 'default' },
      pendingRestart: true,
    });
    expect(env).toEqual(probe.process?.env);
  });

  it("attributes what only the service manager's environment sets to it, with no restart pending", async () => {
    const show = OFFICIAL_SHOW.replace('User=ollama', 'User=')
      .replace(/^Environment=.*$/m, 'Environment="PATH=/usr/bin" OLLAMA_NUM_PARALLEL=2')
      .replace(/^EnvironmentFiles=.*$/m, '')
      .replace(/^DropInPaths=.*$/m, 'DropInPaths=')
      .replace(
        'FragmentPath=/etc/systemd/system/ollama.service',
        'FragmentPath=/home/me/.config/systemd/user/ollama.service'
      );
    const unit = {
      ...parseSystemctlShow(show, 'user'),
      managerEnvironment: { OLLAMA_MODELS: '/data/models', OLLAMA_KEEP_ALIVE: '1h', OLLAMA_NUM_PARALLEL: '8' },
    };
    const root = tree({
      'home/me/.config/systemd/user/ollama.service': OFFICIAL_UNIT.replace(
        'Environment="PATH=/usr/local/bin:/usr/bin"',
        'Environment="PATH=/usr/bin" OLLAMA_NUM_PARALLEL=2'
      ),
    });
    const probe: OllamaInstallProbe = {
      install: { type: 'user-systemd', unit: unit.fragmentPath, binary: '/usr/local/bin/ollama' },
      unit,
      process: {
        pid: 812,
        argv: ['/usr/local/bin/ollama', 'serve'],
        exe: '/usr/local/bin/ollama',
        env: { OLLAMA_MODELS: '/data/models', OLLAMA_KEEP_ALIVE: '1h', OLLAMA_NUM_PARALLEL: '2' },
        containerized: false,
      },
    };
    const { settings } = await readOllamaSettings(probe, { rootDir: root, homeDir: '/home/me' });
    const byKey = Object.fromEntries(settings.settings.map(s => [s.key, s]));
    expect(byKey.OLLAMA_MODELS).toEqual({
      key: 'OLLAMA_MODELS',
      value: '/data/models',
      source: { kind: 'manager', path: null },
      writable: false,
    });
    expect(byKey.OLLAMA_KEEP_ALIVE).toEqual({
      key: 'OLLAMA_KEEP_ALIVE',
      value: '1h',
      source: { kind: 'manager', path: null },
      writable: true,
    });
    expect(byKey.OLLAMA_NUM_PARALLEL).toMatchObject({ value: '2', source: { kind: 'unit' }, writable: true });
    expect(byKey.OLLAMA_NUM_PARALLEL.pendingRestart).toBeUndefined();
  });

  it("reports disable_ollama_cloud from the service user's server.json unless OLLAMA_NO_CLOUD already disables it", async () => {
    const files = {
      ...officialFiles,
      'etc/passwd': 'ollama:x:998:998::/usr/share/ollama:/bin/false\n',
      'usr/share/ollama/.ollama/server.json': '{"disable_ollama_cloud":true}',
    };
    const { settings } = await readOllamaSettings(official(), { rootDir: tree(files) });
    expect(settings.settings.find(s => s.key === 'OLLAMA_NO_CLOUD')).toEqual({
      key: 'OLLAMA_NO_CLOUD',
      value: '1',
      source: { kind: 'config', path: '/usr/share/ollama/.ollama/server.json' },
      writable: false,
    });

    const viaEnv = { ...files, 'etc/default/ollama': 'OLLAMA_NO_CLOUD=true\n' };
    const fromEnv = await readOllamaSettings(official(), { rootDir: tree(viaEnv) });
    expect(fromEnv.settings.settings.find(s => s.key === 'OLLAMA_NO_CLOUD')?.source.kind).toBe('env-file');

    const off = { ...files, 'usr/share/ollama/.ollama/server.json': '{"disable_ollama_cloud":false}' };
    const notSet = await readOllamaSettings(official(), { rootDir: tree(off) });
    expect(notSet.settings.settings.find(s => s.key === 'OLLAMA_NO_CLOUD')?.source.kind).toBe('default');

    const closed = tree(files);
    lock(closed, 'usr/share/ollama/.ollama/server.json');
    const unreadableConfig = await readOllamaSettings(official(), { rootDir: closed });
    expect(unreadableConfig.settings.unreadablePaths).toEqual(['/usr/share/ollama/.ollama/server.json']);
  });

  it('reads server.json from a user unit in this user home', async () => {
    const show = OFFICIAL_SHOW.replace(/^EnvironmentFiles=.*$/m, '');
    const probe: OllamaInstallProbe = {
      install: { type: 'user-systemd', unit: null, binary: null },
      unit: parseSystemctlShow(show, 'user'),
      process: null,
    };
    const root = tree({ ...officialFiles, 'home/me/.ollama/server.json': '{"disable_ollama_cloud":true}' });
    const { settings } = await readOllamaSettings(probe, { rootDir: root, homeDir: '/home/me' });
    expect(settings.settings.find(s => s.key === 'OLLAMA_NO_CLOUD')?.source).toEqual({
      kind: 'config',
      path: '/home/me/.ollama/server.json',
    });
  });

  it('reads a manual process environment as read-only', async () => {
    const probe: OllamaInstallProbe = {
      install: { type: 'manual', unit: null, binary: '/opt/ollama' },
      unit: null,
      process: {
        pid: 77,
        argv: ['/opt/ollama', 'serve'],
        exe: '/opt/ollama',
        env: { OLLAMA_NUM_PARALLEL: '3', HOME: '/home/me' },
        containerized: false,
      },
    };
    const { settings, env } = await readOllamaSettings(probe, { rootDir: tree({}) });
    expect(settings.settings.find(s => s.key === 'OLLAMA_NUM_PARALLEL')).toEqual({
      key: 'OLLAMA_NUM_PARALLEL',
      value: '3',
      source: { kind: 'process', path: '/proc/77/environ' },
      writable: false,
    });
    expect(settings.settings.every(s => !s.writable)).toBe(true);
    expect(env).toEqual({ OLLAMA_NUM_PARALLEL: '3', HOME: '/home/me' });
  });

  it('is unreadable for docker, unknown installs and hidden environments', async () => {
    const unreadableResult = { settings: { readable: false, settings: [], unreadablePaths: [] }, env: {} };
    const process = { pid: 5, argv: ['ollama', 'serve'], exe: null, env: null, containerized: false };
    expect(
      await readOllamaSettings({ install: { type: 'unknown', unit: null, binary: null }, unit: null, process: null })
    ).toEqual(unreadableResult);
    expect(
      await readOllamaSettings({ install: { type: 'manual', unit: null, binary: null }, unit: null, process })
    ).toEqual(unreadableResult);
    expect(
      await readOllamaSettings({
        install: { type: 'docker', unit: null, binary: null },
        unit: null,
        process: { ...process, env: { OLLAMA_HOST: '0.0.0.0' }, containerized: true },
      })
    ).toEqual(unreadableResult);
  });
});
