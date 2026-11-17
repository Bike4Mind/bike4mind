import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Exercises apps/client/scripts/pruneServerTrace.mjs, which edits the .nft.json traces OpenNext
 * builds the hosted server function from. Run as a subprocess: postbuild depends on its exit code.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = path.join(REPO_ROOT, 'apps', 'client', 'scripts', 'pruneServerTrace.mjs');

const PNPM = '../../../../node_modules/.pnpm';
const KEPT = [
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/package.json`,
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/tiktoken.cjs`,
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/tiktoken_bg.wasm`,
  `${PNPM}/next@16.4.5_@playwright+test@1.65.0/node_modules/next/dist/server/next-server.js`,
  `${PNPM}/mongoose@8.24.8/node_modules/mongoose/index.js`,
];
const PRUNED = [
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/encoders/o200k_base.cjs`,
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/lite/tiktoken_bg.wasm`,
  `${PNPM}/playwright-core@1.64.0/node_modules/playwright-core/package.json`,
  `${PNPM}/playwright-core@1.65.0/node_modules/playwright-core/lib/server/index.js`,
  `${PNPM}/playwright@1.65.0/node_modules/playwright-core`,
  `${PNPM}/@playwright+test@1.65.0/node_modules/@playwright/test/index.js`,
];

let tmpRoot: string;

function runScript(args: string[]): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, output: stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

function writeTrace(file: string, files: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, files }));
}

function readTrace(file: string): string[] {
  return (JSON.parse(fs.readFileSync(file, 'utf8')) as { files: string[] }).files;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-server-trace-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('pruneServerTrace.mjs', () => {
  it('drops only the pruned packages from every route trace and the server trace', () => {
    const nextDir = path.join(tmpRoot, '.next');
    fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });
    const routeTrace = path.join(nextDir, 'server', 'pages', 'api', 'chat.js.nft.json');
    const serverTrace = path.join(nextDir, 'next-server.js.nft.json');
    writeTrace(routeTrace, [...KEPT, ...PRUNED]);
    writeTrace(serverTrace, [...PRUNED, ...KEPT]);

    const { status, output } = runScript(['--if-standalone', nextDir]);

    expect(status, output).toBe(0);
    expect(readTrace(routeTrace)).toEqual(KEPT);
    expect(readTrace(serverTrace)).toEqual(KEPT);
    expect(output).toContain(`removed ${PRUNED.length * 2} traced paths across 2 traces`);
  });

  it('leaves the standalone tree traces untouched', () => {
    const nextDir = path.join(tmpRoot, '.next');
    writeTrace(path.join(nextDir, 'server', 'pages', 'index.js.nft.json'), KEPT);
    const standaloneTrace = path.join(nextDir, 'standalone', 'apps', 'client', '.next', 'server', 'x.js.nft.json');
    writeTrace(standaloneTrace, PRUNED);

    expect(runScript(['--if-standalone', nextDir]).status).toBe(0);
    expect(readTrace(standaloneTrace)).toEqual(PRUNED);
  });

  it('is a no-op with --if-standalone when the build wrote no standalone output', () => {
    const nextDir = path.join(tmpRoot, '.next');
    const trace = path.join(nextDir, 'server', 'pages', 'index.js.nft.json');
    writeTrace(trace, PRUNED);

    const { status, output } = runScript(['--if-standalone', nextDir]);

    expect(status).toBe(0);
    expect(output).toContain('nothing to prune');
    expect(readTrace(trace)).toEqual(PRUNED);
  });

  it('fails when a standalone build has no traces, so a layout change cannot silently disable it', () => {
    const nextDir = path.join(tmpRoot, '.next');
    fs.mkdirSync(path.join(nextDir, 'server'), { recursive: true });
    fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });

    const { status, output } = runScript(['--if-standalone', nextDir]);

    expect(status).toBe(1);
    expect(output).toContain('no .nft.json traces');
  });
});
