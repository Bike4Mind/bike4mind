import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/isolated-vm.js`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-x64/isolated-vm.abi137.glibc.node`,
];
const PRUNED = [
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/encoders/o200k_base.cjs`,
  `${PNPM}/tiktoken@1.0.22/node_modules/tiktoken/lite/tiktoken_bg.wasm`,
  `${PNPM}/playwright-core@1.64.0/node_modules/playwright-core/package.json`,
  `${PNPM}/playwright-core@1.65.0/node_modules/playwright-core/lib/server/index.js`,
  `${PNPM}/playwright@1.65.0/node_modules/playwright-core`,
  `${PNPM}/@playwright+test@1.65.0/node_modules/@playwright/test/index.js`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-x64/isolated-vm.abi147.glibc.node`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-arm64/isolated-vm.abi137.glibc.node`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-arm64/isolated-vm.abi147.glibc.node`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-x64/isolated-vm.abi137.musl.node`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/linux-x64/isolated-vm.abi137.glibc.node.bak`,
  `${PNPM}/isolated-vm@7.0.1/node_modules/isolated-vm/prebuilds/darwin-arm64/isolated-vm.abi137.node`,
  '../../node_modules/isolated-vm-775954ddb2422596/prebuilds/linux-arm64/isolated-vm.abi137.glibc.node',
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

  it('still prunes a route directory that shares a name with a skipped root directory', () => {
    const nextDir = path.join(tmpRoot, '.next');
    fs.mkdirSync(path.join(nextDir, 'standalone'), { recursive: true });
    const routeTrace = path.join(nextDir, 'server', 'pages', 'api', 'cache', 'purge.js.nft.json');
    writeTrace(routeTrace, [...KEPT, ...PRUNED]);

    expect(runScript(['--if-standalone', nextDir]).status).toBe(0);
    expect(readTrace(routeTrace)).toEqual(KEPT);
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

// Lambda runtime -> NODE_MODULE_VERSION of the Node major it runs. A runtime bump with no entry
// here fails below, which is the prompt to point HOSTED_SERVER_PREBUILD at the new ABI.
const NODE_ABI_BY_LAMBDA_RUNTIME: Record<string, string> = { 'nodejs24.x': '137' };

describe('the isolated-vm prebuild the hosted server keeps', () => {
  it('matches the runtime and architecture infra/web.ts gives the Next server function', async () => {
    const { HOSTED_SERVER_RUNTIME, HOSTED_SERVER_PREBUILD } = (await import(SCRIPT)) as {
      HOSTED_SERVER_RUNTIME: string;
      HOSTED_SERVER_PREBUILD: string;
    };
    const web = fs.readFileSync(path.join(REPO_ROOT, 'infra', 'web.ts'), 'utf8');
    const serverStart = web.indexOf('    server: {');
    expect(serverStart, 'infra/web.ts Nextjs server block moved').toBeGreaterThan(-1);
    const serverBlock = web.slice(serverStart, web.indexOf('\n    },', serverStart));
    // `transform.server` takes full FunctionArgs, so it can set the architecture too.
    const transformStart = web.indexOf('      server: args => {');
    expect(transformStart, 'infra/web.ts transform.server moved').toBeGreaterThan(-1);
    const transformBlock = web.slice(transformStart, web.indexOf('\n      },', transformStart));
    expect(transformBlock).not.toMatch(/architecture/);

    expect(serverBlock).toContain(`runtime: '${HOSTED_SERVER_RUNTIME}'`);
    // No architecture means SST's x86_64 default; anything other than a literal 'x86_64' (arm64, or
    // a value this test cannot read) needs HOSTED_SERVER_PREBUILD revisited.
    for (const match of serverBlock.matchAll(/architecture:\s*([^,\n]+)/g)) {
      expect(match[1].trim()).toBe("'x86_64'");
    }
    expect(HOSTED_SERVER_PREBUILD).toBe(
      `linux-x64/isolated-vm.abi${NODE_ABI_BY_LAMBDA_RUNTIME[HOSTED_SERVER_RUNTIME]}.glibc.node`
    );
  });

  it('exists in the installed isolated-vm, so the prune never leaves the sandbox with no binary', async () => {
    const { HOSTED_SERVER_PREBUILD } = (await import(SCRIPT)) as { HOSTED_SERVER_PREBUILD: string };
    const clientRequire = createRequire(path.join(REPO_ROOT, 'apps', 'client', 'package.json'));
    const pkgDir = path.dirname(clientRequire.resolve('isolated-vm'));

    expect(fs.existsSync(path.join(pkgDir, 'prebuilds', HOSTED_SERVER_PREBUILD))).toBe(true);
  });
});
