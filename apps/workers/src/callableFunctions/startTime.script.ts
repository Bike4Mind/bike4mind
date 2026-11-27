import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { FUNCTION_CALL_GLUE_PY, PYODIDE_VERSION, type FunctionContract } from '@bike4mind/common';
import { createInProcessCallableFunctionRunner } from '@bike4mind/server-utils/callableFunctions/runtimeRunner';
import {
  CALLABLE_FUNCTION_LIMITS,
  callableFunctionChildArgs,
} from '@bike4mind/server-utils/callableFunctions/runtimeParent';

// Start-time numbers for the callable function runtime on the host it runs on; not run in CI.
// pnpm --filter @bike4mind/workers exec tsx src/callableFunctions/startTime.script.ts

const RUNS = 10;
const CHILD = path.resolve(import.meta.dirname, 'child.ts');
const PYODIDE_DIR = realpathSync(path.dirname(createRequire(import.meta.url).resolve('pyodide')));

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
`;
const PARAMS = { load: 1000, span: 5, elastic_modulus: 200e9, second_moment: 8e-6 };

const p50 = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

const request = (op: 'read_contract' | 'call') =>
  `${JSON.stringify({
    op,
    glue: FUNCTION_CALL_GLUE_PY,
    code: BEAM,
    paramsJson: op === 'call' ? JSON.stringify(PARAMS) : null,
    pyodideVersion: PYODIDE_VERSION,
  })}\n`;

/** Spawn to the run-start line, for a fresh child with the production flags. */
async function coldStart(): Promise<number> {
  const started = performance.now();
  const args = callableFunctionChildArgs(CHILD, PYODIDE_DIR, CALLABLE_FUNCTION_LIMITS.memoryMb);
  const child = spawn(process.execPath, args, { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  const replied = new Promise<void>(resolve => createInterface({ input: child.stdout }).once('line', () => resolve()));
  child.stdin.end(request('read_contract'));
  await replied;
  const elapsed = performance.now() - started;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return elapsed;
}

/** One child with the production flags serving every call, timed after a first warming call. */
async function reusedInterpreter(): Promise<number[]> {
  const args = callableFunctionChildArgs(CHILD, PYODIDE_DIR, CALLABLE_FUNCTION_LIMITS.memoryMb);
  const child = spawn(process.execPath, [...args, '--reuse'], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', line => {
    if ((JSON.parse(line) as { started?: boolean }).started !== true) waiting.shift()?.();
  });
  const call = async (): Promise<number> => {
    const started = performance.now();
    await new Promise<void>(resolve => {
      waiting.push(resolve);
      child.stdin.write(request('call'));
    });
    return performance.now() - started;
  };
  await call();
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) times.push(await call());
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  return times;
}

const print = (line: string) => process.stdout.write(`${line}\n`);

async function main(): Promise<void> {
  print(`loadavg before: ${readFileSync('/proc/loadavg', 'utf8').trim()}`);
  const runner = createInProcessCallableFunctionRunner({ childPath: CHILD, pyodideDir: PYODIDE_DIR });
  const read = await runner({ op: 'read_contract', code: BEAM });
  if (read.outcome !== 'ok') throw new Error(`read_contract returned ${read.outcome}`);
  const contract = read.contract as FunctionContract;

  const cold: number[] = [];
  for (let i = 0; i < RUNS; i++) cold.push(await coldStart());

  const fresh: number[] = [];
  const init: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const result = await runner({ op: 'call', code: BEAM, contract, params: PARAMS });
    if (result.outcome !== 'ok') throw new Error(`call returned ${result.outcome}`);
    fresh.push(result.durationMs);
    init.push(result.initMs ?? 0);
  }

  const reused = await reusedInterpreter();
  print(`cold child start, spawn to first reply (p50 of ${RUNS}): ${Math.round(p50(cold))} ms`);
  print(`warm new process, beam call through a fresh child (p50 of ${RUNS}): ${Math.round(p50(fresh))} ms`);
  print(`  of which Pyodide load inside the child (p50): ${Math.round(p50(init))} ms`);
  print(`reused interpreter, beam call in a loaded child (p50 of ${RUNS}): ${p50(reused).toFixed(1)} ms`);
  print(`loadavg after: ${readFileSync('/proc/loadavg', 'utf8').trim()}`);
}

void main();
