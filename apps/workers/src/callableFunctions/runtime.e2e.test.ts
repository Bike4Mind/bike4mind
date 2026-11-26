import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { FUNCTION_CALL_GLUE_PY, PYODIDE_VERSION, type FunctionContract } from '@bike4mind/common';
import { createInProcessCallableFunctionRunner } from '@bike4mind/server-utils/callableFunctions/runtimeRunner';
import {
  liveCallableFunctionChildren,
  sweepCallableFunctionChildren,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Real Pyodide from this package's own `pyodide` dependency, through the same child the Lambda runs.
const CHILD = path.resolve(import.meta.dirname, 'child.ts');
const PYODIDE_DIR = realpathSync(path.dirname(createRequire(import.meta.url).resolve('pyodide')));
const runner = createInProcessCallableFunctionRunner({ childPath: CHILD, pyodideDir: PYODIDE_DIR });
const SENTINEL = `B4M_CALLABLE_SENTINEL_${process.pid}`;

const BEAM = `
FUNCTION = {
    "name": "beam_midspan_deflection",
    "description": "Midspan deflection of a simply supported beam under a uniform load.",
    "inputs": {
        "type": "object",
        "additionalProperties": False,
        "required": ["load", "span", "elastic_modulus", "second_moment"],
        "properties": {
            "load": {"type": "number", "unit": "N/m", "exclusiveMinimum": 0},
            "span": {"type": "number", "unit": "m", "exclusiveMinimum": 0},
            "elastic_modulus": {"type": "number", "unit": "Pa", "exclusiveMinimum": 0},
            "second_moment": {"type": "number", "unit": "m^4", "exclusiveMinimum": 0},
        },
    },
    "outputs": {
        "type": "object",
        "additionalProperties": False,
        "required": ["deflection"],
        "properties": {"deflection": {"type": "number", "unit": "m"}},
    },
}


def run(load, span, elastic_modulus, second_moment):
    return {"deflection": 5 * load * span**4 / (384 * elastic_modulus * second_moment)}


if __name__ == "__main__":
    raise SystemExit("a __main__ block must not run")
`;

const PROBE_CONTRACT: FunctionContract = {
  name: 'probe',
  description: 'Tries to reach the host.',
  inputs: { type: 'object', additionalProperties: false, properties: { arg: { type: 'string' } } },
  outputs: {
    type: 'object',
    additionalProperties: false,
    properties: { reached: { type: 'boolean' }, detail: { type: 'string' } },
  },
};

const SERIES_CONTRACT: FunctionContract = {
  name: 'series',
  description: 'Counts or returns a series of numbers.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    properties: {
      samples: { type: 'array', items: { type: 'number', unit: '1' } },
      count: { type: 'integer', unit: '1', minimum: 0 },
    },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['values'],
    properties: { values: { type: 'array', items: { type: 'number', unit: '1' } } },
  },
};

const pythonLiteral = (contract: object): string => JSON.stringify(contract).replace(/\bfalse\b/g, 'False');

const DATA_CONTRACT: FunctionContract = {
  name: 'data_probe',
  description: 'Reads a pinned file and tries to write beside it.',
  inputs: { type: 'object', additionalProperties: false, properties: {} },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['content', 'outcomes', 'file_mode', 'dir_mode'],
    properties: {
      content: { type: 'string' },
      outcomes: { type: 'array', items: { type: 'string' } },
      file_mode: { type: 'integer', unit: '1' },
      dir_mode: { type: 'integer', unit: '1' },
    },
  },
};

const DATA_GUEST = `
FUNCTION = ${pythonLiteral(DATA_CONTRACT)}


def run():
    import errno
    import os

    with open("/data/points.csv") as f:
        content = f.read()
    attempts = {
        "overwrite": lambda: open("/data/points.csv", "w").close(),
        "append": lambda: open("/data/points.csv", "a").close(),
        "create": lambda: open("/data/added.csv", "w").close(),
        "remove": lambda: os.remove("/data/points.csv"),
        "rename": lambda: os.rename("/data/points.csv", "/data/moved.csv"),
        "mkdir": lambda: os.mkdir("/data/sub"),
        "chmod": lambda: os.chmod("/data/points.csv", 0o644),
    }
    outcomes = []
    for name, attempt in sorted(attempts.items()):
        try:
            attempt()
            outcome = "accepted"
        except OSError as e:
            outcome = type(e).__name__ + ":EACCES" if e.errno == errno.EACCES else "refused"
        except BaseException:
            outcome = "refused"
        outcomes.append(name + "=" + outcome)
    return {
        "content": content,
        "outcomes": outcomes,
        "file_mode": os.stat("/data/points.csv").st_mode & 0o777,
        "dir_mode": os.stat("/data").st_mode & 0o777,
    }
`;

const probe = (attempt: string) => `
FUNCTION = ${pythonLiteral(PROBE_CONTRACT)}

${attempt.trim()}


def run(arg=""):
    try:
        reached, detail = attempt(arg)
    except BaseException as e:
        return {"reached": False, "detail": type(e).__name__ + ": " + str(e)[:120]}
    return {"reached": bool(reached), "detail": str(detail)[:300]}
`;

interface HostileCase {
  name: string;
  attempt: string;
  arg?: () => string;
  /** Judged by a loopback listener instead of the guest's own answer. */
  network?: boolean;
  /** Plants in one call and looks in the next. */
  state?: boolean;
}

const CASES: HostileCase[] = [
  {
    name: 'import js',
    attempt: `
def attempt(arg):
    import js
    return True, "process " + str(js.process.version)`,
  },
  {
    name: 'import pyodide_js',
    attempt: `
def attempt(arg):
    import pyodide_js
    return True, "pyodide_js " + str(pyodide_js.version)`,
  },
  {
    name: 'from pyodide import ffi',
    attempt: `
def attempt(arg):
    from pyodide import ffi
    return True, "JS " + str(ffi.to_js([1]).constructor.name)`,
  },
  {
    name: 'import pyodide.ffi',
    attempt: `
def attempt(arg):
    import pyodide.ffi
    return True, "JS " + str(pyodide.ffi.to_js([1]).constructor.name)`,
  },
  {
    name: 'os.environ holds the parent sentinel',
    arg: () => SENTINEL,
    attempt: `
def attempt(arg):
    import os
    return arg in os.environ, "sentinel %s among %d variables" % ("present" if arg in os.environ else "absent", len(os.environ))`,
  },
  {
    name: 'open a socket',
    network: true,
    attempt: `
def attempt(arg):
    import socket
    try:
        socket.create_connection(("127.0.0.1", int(arg)), timeout=1)
        return True, "socket"
    except OSError:
        pass
    import js
    js.process.getBuiltinModule("node:net").connect(int(arg), "127.0.0.1")
    return True, "node net through js"`,
  },
  {
    name: 'urllib fetch',
    network: true,
    attempt: `
def attempt(arg):
    import urllib.request
    try:
        urllib.request.urlopen("http://127.0.0.1:" + arg + "/", timeout=1)
        return True, "urllib"
    except OSError:
        pass
    import js
    js.fetch("http://127.0.0.1:" + arg + "/")
    return True, "fetch through js"`,
  },
  {
    name: 'pyodide.http fetch',
    network: true,
    attempt: `
def attempt(arg):
    import asyncio
    from pyodide.http import pyfetch
    asyncio.ensure_future(pyfetch("http://127.0.0.1:" + arg + "/"))
    return True, "pyfetch scheduled"`,
  },
  {
    name: 'read /proc',
    attempt: `
def attempt(arg):
    try:
        with open("/proc/self/status") as f:
            return "VmRSS" in f.read(), "in-memory /proc"
    except OSError:
        pass
    import js
    text = js.process.getBuiltinModule("node:fs").readFileSync("/proc/self/status", "utf8")
    return "VmRSS" in str(text), "host /proc through js"`,
  },
  {
    name: 'read the host file system',
    arg: () => CHILD,
    attempt: `
def attempt(arg):
    try:
        with open(arg) as f:
            return "unsafe-no-isolation" in f.read(), "direct"
    except OSError:
        pass
    import js
    import pyodide_js
    from pyodide.ffi import to_js
    fs = pyodide_js.FS
    fs.mkdir("/host")
    fs.mount(fs.filesystems.NODEFS, to_js({"root": "/"}, dict_converter=js.Object.fromEntries), "/host")
    with open("/host" + arg) as f:
        return "unsafe-no-isolation" in f.read(), "host mounted through pyodide_js"`,
  },
  {
    name: 'ctypes: read interpreter memory',
    attempt: `
def attempt(arg):
    import ctypes
    return len(ctypes.string_at(id(arg), 16)) == 16, "16 bytes at id(arg)"`,
  },
  {
    name: 'ctypes: generate JavaScript',
    attempt: `
def attempt(arg):
    import ctypes
    run = ctypes.CDLL(None).emscripten_run_script_string
    run.restype = ctypes.c_char_p
    return True, "eval returned " + run(b"String(6 * 7)").decode()`,
  },
  {
    name: 'ctypes: reach the host process',
    attempt: `
def attempt(arg):
    import ctypes
    run = ctypes.CDLL(None).emscripten_run_script_string
    run.restype = ctypes.c_char_p
    script = b"String(process.getBuiltinModule('node:child_process').execFileSync(process.execPath, ['--version']))"
    return True, "node " + run(script).decode().strip()`,
  },
  {
    name: 'ctypes: open a socket',
    network: true,
    attempt: `
def attempt(arg):
    import ctypes
    run = ctypes.CDLL(None).emscripten_run_script
    run(("process.getBuiltinModule('node:net').connect(" + str(int(arg)) + ", '127.0.0.1')").encode())
    return True, "node net through eval"`,
  },
  {
    name: 'ctypes: read the host file system',
    arg: () => CHILD,
    attempt: `
def attempt(arg):
    import ctypes
    import json
    run = ctypes.CDLL(None).emscripten_run_script_string
    run.restype = ctypes.c_char_p
    script = "String(process.getBuiltinModule('node:fs').readFileSync(" + json.dumps(arg) + ", 'utf8').includes('unsafe-no-isolation'))"
    return run(script.encode()) == b"true", "host file through eval"`,
  },
  {
    name: 'subprocess',
    attempt: `
def attempt(arg):
    import subprocess
    try:
        subprocess.run(["true"])
        return True, "subprocess"
    except Exception:
        pass
    import js
    from pyodide.ffi import to_js
    options = to_js({"encoding": "utf8"}, dict_converter=js.Object.fromEntries)
    out = js.process.getBuiltinModule("node:child_process").execFileSync(js.process.execPath, to_js(["--version"]), options)
    return True, "host process through js: node " + str(out).strip()`,
  },
  {
    name: 'generate JS code through a bridge recovered from gc',
    attempt: `
def attempt(arg):
    import gc
    for o in gc.get_objects():
        if type(o).__name__ == "module" and getattr(o, "__name__", "") == "_pyodide_core":
            array = o.to_js([1])
            return True, "typeof process: " + str(array.constructor.constructor("return typeof process")())
    return False, "no bridge module found"`,
  },
  {
    name: 'module globals from a previous call',
    state: true,
    attempt: `
def attempt(arg):
    import json
    if arg == "plant":
        json.b4m_planted = "planted"
        return False, "planted"
    return hasattr(json, "b4m_planted"), "looked"`,
  },
  {
    name: 'a file in the in-memory file system from a previous call',
    state: true,
    attempt: `
def attempt(arg):
    import os
    if arg == "plant":
        with open("/tmp/b4m_planted.txt", "w") as f:
            f.write("planted")
        return False, "planted"
    return os.path.exists("/tmp/b4m_planted.txt"), "looked"`,
  },
  {
    name: 'a monkeypatched builtin from a previous call',
    state: true,
    attempt: `
def attempt(arg):
    import builtins
    if arg == "plant":
        builtins.sorted = lambda *a, **k: "planted"
        return False, "planted"
    return sorted([2, 1]) == "planted", "looked"`,
  },
];

interface Attempt {
  /** The guest ran and returned, so a false `reached` is its own finding, not a refusal to run it. */
  ran: boolean;
  reached: boolean;
  detail: string;
}

const listen = async (): Promise<{ port: number; connections: () => number; close: () => void }> => {
  let count = 0;
  const server = net.createServer(socket => {
    count++;
    socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    connections: () => count,
    close: () => server.close(),
  };
};

const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return check();
};

const asAttempt = (value: unknown): Attempt => {
  const record = (value ?? {}) as Partial<Attempt>;
  return { ran: true, reached: record.reached === true, detail: String(record.detail ?? '') };
};

/** Every isolation layer off: parent env, no node flags, bridge kept, one interpreter serving every call. */
function startUnisolatedChild() {
  const child = spawn(process.execPath, [CHILD, PYODIDE_DIR, '--unsafe-no-isolation', '--reuse'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const waiting: Array<(line: string) => void> = [];
  createInterface({ input: child.stdout }).on('line', line => {
    if ((JSON.parse(line) as { started?: boolean }).started !== true) waiting.shift()?.(line);
  });
  const call = (code: string, arg: string) =>
    new Promise<Attempt>(resolve => {
      waiting.push(line => {
        const reply = JSON.parse(line) as { outputsJson?: string; error?: string };
        resolve(
          reply.outputsJson ? asAttempt(JSON.parse(reply.outputsJson)) : { ran: false, reached: false, detail: 'error' }
        );
      });
      const request = {
        op: 'call',
        glue: FUNCTION_CALL_GLUE_PY,
        code,
        paramsJson: JSON.stringify({ arg }),
        pyodideVersion: PYODIDE_VERSION,
      };
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  return { child, call };
}

const isolatedCall = async (code: string, arg: string): Promise<Attempt> => {
  const result = await runner({ op: 'call', code, contract: PROBE_CONTRACT, params: { arg } });
  return result.outcome === 'ok'
    ? asAttempt(result.outputs)
    : { ran: false, reached: false, detail: `${result.outcome} ${result.reason ?? ''}` };
};

async function attemptWith(
  call: (code: string, arg: string) => Promise<Attempt>,
  hostile: HostileCase
): Promise<Attempt> {
  const code = probe(hostile.attempt);
  if (hostile.state) {
    const planted = await call(code, 'plant');
    const looked = await call(code, 'look');
    return { ...looked, ran: planted.ran && looked.ran };
  }
  if (!hostile.network) return call(code, hostile.arg?.() ?? '');
  const listener = await listen();
  try {
    const answer = await call(code, String(listener.port));
    const reached = await waitFor(() => listener.connections() > 0, 3000);
    return { ran: answer.ran, reached, detail: `${listener.connections()} connection(s); guest said ${answer.detail}` };
  } finally {
    listener.close();
  }
}

const pidGone = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** Time from the run-start line to the end of the run. */
const runMs = (result: { durationMs: number; startMs?: number }) => result.durationMs - (result.startMs ?? NaN);

const spawnedPids = (): Array<number | undefined> =>
  vi.mocked(spawn).mock.results.map(result => (result.value as ChildProcess).pid);

describe('callable function runtime with real Pyodide', () => {
  const unisolated = new Map<string, Attempt>();
  const table: string[] = [];
  let offChild: ChildProcess | undefined;

  beforeAll(async () => {
    vi.stubEnv(SENTINEL, 'planted by the test');
    const { child, call } = startUnisolatedChild();
    offChild = child;
    for (const hostile of CASES) unisolated.set(hostile.name, await attemptWith(call, hostile));
  }, 240_000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    if (offChild && offChild.exitCode === null) {
      const exited = new Promise(resolve => offChild?.once('exit', resolve));
      offChild.kill('SIGKILL');
      await exited;
    }
    console.log(['| Attempt | Isolation off | Isolation on |', '|---|---|---|', ...table].join('\n'));
  });

  it('runs the beam example through a fresh child and returns its outputs', async () => {
    const params = { load: 1000, span: 5, elastic_modulus: 200e9, second_moment: 8e-6 };
    const read = await runner({ op: 'read_contract', code: BEAM });
    expect(read.outcome).toBe('ok');
    const contract = read.contract as FunctionContract;
    const result = await runner({ op: 'call', code: BEAM, contract, params });
    expect(result.outcome).toBe('ok');
    expect(result.outputs?.deflection).toBeCloseTo((5 * 1000 * 5 ** 4) / (384 * 200e9 * 8e-6), 12);
    const lock = readFileSync(path.join(PYODIDE_DIR, 'pyodide-lock.json'));
    expect(result.runtime).toEqual({ lockHash: createHash('sha256').update(lock).digest('hex'), packages: [] });
    expect(spawnedPids().slice(-2).every(pidGone)).toBe(true);
    expect(liveCallableFunctionChildren()).toEqual([]);
  }, 120_000);

  it('reports a guest SystemExit as an error with its printed output, and takes the class from the type', async () => {
    const guest = (body: string) =>
      `${BEAM.split('\n\n\ndef run')[0]}\n\n\ndef run(load, span, elastic_modulus, second_moment):\n${body}\n`;
    const params = { load: 1, span: 1, elastic_modulus: 1, second_moment: 1 };
    const contract = (await runner({ op: 'read_contract', code: BEAM })).contract as FunctionContract;
    const exited = await runner({
      op: 'call',
      code: guest('    print("before exit")\n    raise SystemExit(3)'),
      contract,
      params,
    });
    expect(exited).toMatchObject({ outcome: 'error', errorClass: 'SystemExit' });
    expect(exited.printed).toContain('before exit');
    const spoofed = await runner({
      op: 'call',
      code: guest('    raise ValueError("bad\\nMemoryError")'),
      contract,
      params,
    });
    expect(spoofed).toMatchObject({ outcome: 'error', errorClass: 'ValueError' });
  }, 120_000);

  it('takes the class of an exception that escapes the glue from its type', async () => {
    const contract = (await runner({ op: 'read_contract', code: BEAM })).contract as FunctionContract;
    // The glue formats a guest error with traceback.format_exc, so a MemoryError raised there escapes the glue.
    const code = `${BEAM.split('\n\n\ndef run')[0]}


def run(load, span, elastic_modulus, second_moment):
    import traceback

    def fail(*args, **kwargs):
        raise MemoryError()

    traceback.format_exc = fail
    raise ValueError("bad")
`;
    const result = await runner({
      op: 'call',
      code,
      contract,
      params: { load: 1, span: 1, elastic_modulus: 1, second_moment: 1 },
    });
    expect(result).toMatchObject({ outcome: 'memory', errorClass: 'MemoryError' });
  }, 120_000);

  it('ends a guest that never returns at its own limit, timed from its run start, and leaves no child', async () => {
    const code = probe('def attempt(arg):\n    while True:\n        pass');
    const result = await runner({
      op: 'call',
      code,
      contract: PROBE_CONTRACT,
      params: {},
      limits: { timeoutMs: 2000 },
    });
    expect(result.outcome).toBe('timeout');
    expect(result.startMs).toBeGreaterThan(0);
    expect(runMs(result)).toBeGreaterThanOrEqual(2000);
    expect(runMs(result)).toBeLessThan(3000);
    expect(pidGone(spawnedPids().at(-1))).toBe(true);
    expect(liveCallableFunctionChildren()).toEqual([]);
  }, 120_000);

  it('ends a 5 s sleep at a 2 s limit', async () => {
    const code = probe('def attempt(arg):\n    import time\n    time.sleep(5)\n    return True, "slept"');
    const result = await runner({
      op: 'call',
      code,
      contract: PROBE_CONTRACT,
      params: {},
      limits: { timeoutMs: 2000 },
    });
    expect(result.outcome).toBe('timeout');
    expect(runMs(result)).toBeGreaterThanOrEqual(2000);
    expect(runMs(result)).toBeLessThan(3000);
  }, 120_000);

  it('keeps guest stdout off the pipe, so a forged run-start line or reply changes nothing', async () => {
    const forged = `
def attempt(arg):
    import os
    import sys
    started = '{"started": true}\\n'
    reply = '{"ok": true, "initMs": 0, "printed": "", "contractJson": "{}", "outputsJson": "{}"}\\n'
    for line in (started, reply):
        print(line, end="")
        sys.__stdout__.write(line)
        sys.__stdout__.flush()
        os.write(1, line.encode())
    while arg == "loop":
        pass
    return False, "returned"`;
    const call = (arg: string, timeoutMs: number) =>
      runner({ op: 'call', code: probe(forged), contract: PROBE_CONTRACT, params: { arg }, limits: { timeoutMs } });
    const returned = await call('return', 30_000);
    expect(returned).toMatchObject({ outcome: 'ok', outputs: { reached: false, detail: 'returned' } });
    expect(returned.printed).toBe(
      '{"started": true}\n{"ok": true, "initMs": 0, "printed": "", "contractJson": "{}", "outputsJson": "{}"}\n'
    );
    const looped = await call('loop', 2000);
    expect(looped.outcome).toBe('timeout');
    expect(runMs(looped)).toBeLessThan(3000);
  }, 120_000);

  it('takes a 4.9 MB input, returns a 4.9 MB output, and refuses a 5.1 MB output', async () => {
    const MIB = 1024 * 1024;
    // json.dumps writes `0.5, ` for each item: five bytes.
    const code = `FUNCTION = ${pythonLiteral(SERIES_CONTRACT)}\n\n\ndef run(samples=(), count=0):\n    return {"values": [len(samples)] if samples else [0.5] * count}\n`;
    const call = (params: Record<string, unknown>) => runner({ op: 'call', code, contract: SERIES_CONTRACT, params });
    const samples = new Array(Math.floor((4.9 * MIB) / 4)).fill(0.5);
    expect(await call({ samples })).toMatchObject({ outcome: 'ok', outputs: { values: [samples.length] } });
    const fits = await call({ count: Math.floor((4.9 * MIB) / 5) });
    expect(fits.outcome).toBe('ok');
    expect(fits.outputs?.values).toHaveLength(Math.floor((4.9 * MIB) / 5));
    expect(await call({ count: Math.floor((5.1 * MIB) / 5) })).toMatchObject({
      outcome: 'output_too_large',
      reason: 'result_too_large',
    });
  }, 120_000);

  // Concurrent: each attempt runs in children of its own, and the start of each child is most of the file's time.
  CASES.forEach((hostile, index) => {
    it.concurrent(
      `a guest that tries ${hostile.name} reaches nothing`,
      async () => {
        const off = unisolated.get(hostile.name);
        const on = await attemptWith(isolatedCall, hostile);
        const verdict = (attempt?: Attempt) => `${attempt?.reached ? 'succeeds' : 'fails'}: ${attempt?.detail}`;
        table[index] = `| ${hostile.name} | ${verdict(off)} | ${verdict(on)} |`;
        expect(off?.reached, 'the attempt must succeed with isolation off, or this test cannot fail').toBe(true);
        expect(on.ran, 'the guest must run with isolation on').toBe(true);
        expect(on.reached).toBe(false);
      },
      120_000
    );
  });

  it('names the packages loaded before guest code ran, so a guest that edits the list changes nothing', async () => {
    const child = spawn(process.execPath, [CHILD, PYODIDE_DIR, '--unsafe-no-isolation'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const replied = new Promise<{ packages?: string[]; outputsJson?: string }>(resolve => {
      createInterface({ input: child.stdout }).on('line', line => {
        const message = JSON.parse(line) as { started?: boolean };
        if (message.started !== true) resolve(message);
      });
    });
    const code = probe(`
def attempt(arg):
    import pyodide_js
    pyodide_js.loadedPackages.numpy = "forged"
    return getattr(pyodide_js.loadedPackages, "numpy", None) == "forged", "wrote numpy into loadedPackages"
`);
    const request = {
      op: 'call',
      glue: FUNCTION_CALL_GLUE_PY,
      code,
      paramsJson: '{"arg": ""}',
      pyodideVersion: PYODIDE_VERSION,
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    const reply = await replied;
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    expect(asAttempt(JSON.parse(reply.outputsJson ?? '{}')).reached).toBe(true);
    expect(reply.packages).toEqual([]);
  }, 120_000);

  // A sweep, not the live set: a run keeps its pid in the set when its group outlived the reap.
  it('leaves no child once the hostile attempts end', () => {
    expect(sweepCallableFunctionChildren()).toBe(0);
  });
});

describe('pinned data with real Pyodide', () => {
  it('reads the pinned bytes under /data and refuses every guest write there, in the call directory too', async () => {
    const csv = Buffer.from('x,y\n1,2\n3,5\n');
    const sha256 = createHash('sha256').update(csv).digest('hex');
    const dataCacheDir = mkdtempSync(path.join(tmpdir(), 'fn-data-e2e-'));
    const withData = createInProcessCallableFunctionRunner({
      childPath: CHILD,
      pyodideDir: PYODIDE_DIR,
      dataCacheDir,
      fetchData: async () => new Response(new Uint8Array(csv)),
    });
    const data = [
      { name: 'points.csv', prefix: 'fn1', sha256, bytes: csv.length, url: 'https://data.example.com/signed' },
    ];
    const result = await withData({ op: 'call', code: DATA_GUEST, contract: DATA_CONTRACT, params: {}, data });
    expect(result.outcome).toBe('ok');
    expect(result.outputs?.content).toBe(csv.toString('utf8'));
    expect(result.outputs?.file_mode).toBe(0o444);
    expect(result.outputs?.dir_mode).toBe(0o555);
    // EACCES is Pyodide's own mode check. The host refuses the chmod, which Pyodide reports as success; the file
    // still reads 0444 above because the mode is read after every attempt.
    expect(result.outputs?.outcomes).toEqual([
      'append=PermissionError:EACCES',
      'chmod=accepted',
      'create=PermissionError:EACCES',
      'mkdir=PermissionError:EACCES',
      'overwrite=PermissionError:EACCES',
      'remove=PermissionError:EACCES',
      'rename=PermissionError:EACCES',
    ]);
    const cached = readFileSync(path.join(dataCacheDir, 'cache', 'fn1', sha256));
    expect(createHash('sha256').update(cached).digest('hex')).toBe(sha256);
    expect(readdirSync(path.join(dataCacheDir, 'calls'))).toEqual([]);
    expect(sweepCallableFunctionChildren()).toBe(0);
  }, 120_000);
});
