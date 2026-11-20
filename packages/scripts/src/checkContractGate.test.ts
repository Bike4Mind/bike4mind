import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-contract-gate.sh.
 *
 * Each case builds a throwaway directory tree and runs the real script against it, so the
 * assertions cover the shipped shell rather than a reimplementation. Nothing here touches
 * the working repo. Mirrors the shape of checkNoSmartPunctuation.test.ts.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts', 'check-contract-gate.sh');
const BASH = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash';

const sandboxes: string[] = [];

afterEach(() => {
  while (sandboxes.length) fs.rmSync(sandboxes.pop()!, { recursive: true, force: true });
});

function makeTree(): {
  dir: string;
  v1Dir: string;
  infraDir: string;
  allowlist: string;
  apiKeyAllowlist: string;
  unmeteredAllowlist: string;
  functionUrlAllowlist: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
  sandboxes.push(dir);
  const v1Dir = path.join(dir, 'apps', 'client', 'pages', 'api', 'v1');
  fs.mkdirSync(v1Dir, { recursive: true });
  const infraDir = path.join(dir, 'infra');
  fs.mkdirSync(infraDir, { recursive: true });
  const allowlist = path.join(dir, 'scripts', 'contract-gate-allowlist.txt');
  fs.mkdirSync(path.dirname(allowlist), { recursive: true });
  fs.writeFileSync(allowlist, '# header-only\n', 'utf8');
  const apiKeyAllowlist = path.join(dir, 'scripts', 'contract-gate-api-key-allowlist.txt');
  fs.writeFileSync(apiKeyAllowlist, '# header-only\n', 'utf8');
  const unmeteredAllowlist = path.join(dir, 'scripts', 'unmetered-llm-route-allowlist.txt');
  fs.writeFileSync(unmeteredAllowlist, '# header-only\n', 'utf8');
  const functionUrlAllowlist = path.join(dir, 'scripts', 'contract-gate-function-url-allowlist.txt');
  fs.writeFileSync(functionUrlAllowlist, '# header-only\n', 'utf8');
  return { dir, v1Dir, infraDir, allowlist, apiKeyAllowlist, unmeteredAllowlist, functionUrlAllowlist };
}

// Writes a handler relative to pages/api (not pages/api/v1); returns its repo-relative path.
function writeApiHandler(dir: string, rel: string, content: string): string {
  const repoRel = path.join('apps', 'client', 'pages', 'api', rel);
  const full = path.join(dir, repoRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return repoRel;
}

const JWT_ONLY = `export default baseApi({ auth: 'jwtOnly' }).get((req, res) => res.json({}));\n`;
const API_KEY = `export default baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));\n`;

function writeHandler(v1Dir: string, rel: string, content: string): string {
  const full = path.join(v1Dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return path.join('apps', 'client', 'pages', 'api', 'v1', rel);
}

// Writes a Lambda handler relative to apps/workers/src; returns its repo-relative path.
function writeWorker(dir: string, rel: string, content: string): string {
  const repoRel = path.join('apps', 'workers', 'src', rel);
  const full = path.join(dir, repoRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return repoRel;
}

// Writes an SST declaration relative to infra/; returns its repo-relative path.
function writeInfra(dir: string, rel: string, content: string): string {
  const repoRel = path.join('infra', rel);
  const full = path.join(dir, repoRel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return repoRel;
}

function fnDeclaration(handler: string, url: string): string {
  return `export const lambda = new sst.aws.Function('Lambda', {\n  handler: '${handler}',\n  url: ${url},\n});\n`;
}

// Any v1 file without nextRouteForContract is a violator -- predicate is presence-only.
const VIOLATING = `
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));
export default h;
`.trimStart();

// A file with nextRouteForContract is exempt, regardless of anything else it imports.
const EXEMPT = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

/**
 * Critical regression fixture: has BOTH nextRouteForContract AND baseApi({ requiredScopes }).
 * Removing the exemption branch (the files_missing check in scripts/check-contract-gate.sh) must break this test.
 */
const EXEMPT_DUAL = `
import { nextRouteForContract } from '@server/middlewares/nextRouteForContract';
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] });
export default nextRouteForContract(contract, async (req) => ({ data: null }));
`.trimStart();

// A file with a TODO comment about nextRouteForContract but NO actual import -- still a violator.
const VIOLATING_TODO_COMMENT = `
// TODO: port to nextRouteForContract
import { baseApi } from '@server/middlewares/baseApi';
const h = baseApi({ requiredScopes: ['read:data'] }).get((req, res) => res.json({}));
export default h;
`.trimStart();

function runGuard(dir: string, args: string[] = []) {
  const r = spawnSync(BASH, [GUARD, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env },
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('check-contract-gate.sh', () => {
  it('is present and executable', () => {
    expect(fs.existsSync(GUARD)).toBe(true);
    expect(fs.statSync(GUARD).mode & 0o111).toBeGreaterThan(0);
  });

  it('is wired in .github/workflows/ci.yml', () => {
    const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(/bash\s+scripts\/check-contract-gate\.sh/);
  });

  it('exits 0 and reports OK when there are no violations', () => {
    const { dir, v1Dir } = makeTree();
    writeHandler(v1Dir, 'clean.ts', EXEMPT);
    const r = runGuard(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('exits 1 when the allowlist file is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'scripts', 'contract-gate-allowlist.txt'));
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*Allowlist not found/);
  });

  it('exits 1 when the api-key allowlist file is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'scripts', 'contract-gate-api-key-allowlist.txt'));
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*Allowlist not found/);
  });

  it('exits 1 when the unmetered-LLM allowlist file is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'scripts', 'unmetered-llm-route-allowlist.txt'));
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*Allowlist not found/);
  });

  it('exits 1 when the API directory is missing', () => {
    const { dir } = makeTree();
    fs.rmSync(path.join(dir, 'apps'), { recursive: true });
    const r = runGuard(dir);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ERROR.*API directory not found/);
  });

  it('exits 0 with a header-only allowlist and no violators', () => {
    const { dir } = makeTree();
    expect(runGuard(dir).status).toBe(0);
  });

  describe('contract-adapter exemption (critical regression)', () => {
    // Removing the files_missing check in scripts/check-contract-gate.sh must break this.
    it('does NOT flag a file that contains nextRouteForContract, even if it also imports baseApi', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'dual.ts', EXEMPT_DUAL);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain(rel);
    });
  });

  describe('violation detection', () => {
    it('flags a v1 file that lacks nextRouteForContract and reports its path', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('flags a file whose only mention of nextRouteForContract is a TODO comment', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'todo-bypass.ts', VIOLATING_TODO_COMMENT);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('flags a .tsx file that lacks nextRouteForContract', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'bad.tsx', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    // chmod 000 does not stop root, so the unreadable-directory scenario cannot be built there.
    it.skipIf(process.getuid?.() === 0)('exits 1 instead of reporting OK when part of v1 is unreadable', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'locked/bad.ts', VIOLATING);
      const locked = path.join(v1Dir, 'locked');
      fs.chmodSync(locked, 0o000);
      try {
        const r = runGuard(dir);
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('::error::');
        expect(r.stdout).not.toContain('OK');
      } finally {
        fs.chmodSync(locked, 0o755);
      }
    });

    it.skipIf(process.getuid?.() === 0)(
      'exits 1 instead of reporting OK when a directory outside v1 is unreadable',
      () => {
        const { dir } = makeTree();
        writeApiHandler(dir, 'locked/bad.ts', API_KEY);
        const locked = path.join(dir, 'apps/client/pages/api/locked');
        fs.chmodSync(locked, 0o000);
        try {
          const r = runGuard(dir);
          expect(r.status).toBe(1);
          expect(r.stdout).toContain('find failed');
          expect(r.stdout).not.toContain('OK');
        } finally {
          fs.chmodSync(locked, 0o755);
        }
      }
    );

    // A single unreadable file makes grep (not find) fail, which must fail closed too.
    it.skipIf(process.getuid?.() === 0).each([
      ['under v1', true],
      ['outside v1', false],
    ])('exits 1 instead of reporting OK when a handler file is unreadable (%s)', (_label, inV1) => {
      const { dir, v1Dir } = makeTree();
      const rel = inV1 ? writeHandler(v1Dir, 'locked.ts', VIOLATING) : writeApiHandler(dir, 'locked.ts', API_KEY);
      const full = path.join(dir, rel);
      fs.chmodSync(full, 0o000);
      try {
        const r = runGuard(dir);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('grep failed');
        expect(r.stdout).not.toContain('OK');
      } finally {
        fs.chmodSync(full, 0o644);
      }
    });

    it('does not flag files under __tests__/', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, '__tests__/bad.test.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('does not flag files under the top-level pages/api/premium-* stubs', () => {
      const { dir } = makeTree();
      writeApiHandler(dir, 'premium-overlay/bad.ts', API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('still flags a top-level premium-* file (only directories are stubs)', () => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, 'premium-foo.ts', API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('still flags a premium-* directory nested outside v1', () => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, 'foo/premium-x/a.ts', API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('still flags a premium-* directory nested below pages/api/v1', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'sub/premium-overlay/bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it.each(['bad.js', 'bad.jsx'])('flags a v1 %s that lacks nextRouteForContract', name => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, name, VIOLATING);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('ignores non-routable extensions such as .mjs', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'bad.mjs', VIOLATING);
      expect(runGuard(dir).status).toBe(0);
    });
  });

  describe('outside-v1 jwtOnly ratchet', () => {
    it('flags a non-jwtOnly handler outside v1 and reports its path', () => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, 'foo.ts', API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
      expect(r.stdout).toContain('::error::');
    });

    it.each([["baseApi({ auth: 'jwtOnly' })"], ['baseApi({ auth: "jwtOnly" })'], ["baseApi({auth:'jwtOnly'})"]])(
      'passes a jwtOnly handler outside v1: %s',
      call => {
        const { dir } = makeTree();
        writeApiHandler(dir, 'foo.ts', `export default ${call};\n`);
        expect(runGuard(dir).status).toBe(0);
      }
    );

    it('does not accept an auth: jwtOnly literal inside a doc comment', () => {
      const { dir } = makeTree();
      const rel = writeApiHandler(
        dir,
        'foo.ts',
        `/**\n * Not \`auth: 'jwtOnly'\`: this route accepts API keys\n */\n${API_KEY}`
      );
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('does not accept the bare word jwtOnly in a comment', () => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, 'foo.ts', `// TODO: make jwtOnly\n${API_KEY}`);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it.each(['foo.js', 'foo.jsx', 'nested/deep/foo.tsx'])('scans %s', name => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, name, API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('ignores .mjs and files under __tests__/', () => {
      const { dir } = makeTree();
      writeApiHandler(dir, 'foo.mjs', API_KEY);
      writeApiHandler(dir, 'sub/__tests__/foo.test.ts', API_KEY);
      expect(runGuard(dir).status).toBe(0);
    });

    it.each(['v1.ts', 'v1x/a.ts'])('scans %s next to the v1 directory', name => {
      const { dir } = makeTree();
      const rel = writeApiHandler(dir, name, API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('does not report a duplicated allowlist entry as stale while the file still violates', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'legacy.ts', API_KEY);
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}\n${rel}  # again\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('INFO');
    });

    it('does not apply the jwtOnly rule to v1 files (no double-gating)', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'clean.ts', EXEMPT);
      expect(runGuard(dir).status).toBe(0);
    });

    it('passes an allowlisted handler', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'legacy.ts', API_KEY);
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}  # reason\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('reports a stale entry (now jwtOnly) as INFO and exits 0', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'converted.ts', JWT_ONLY);
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain('contract-gate-api-key-allowlist.txt');
      expect(r.stdout).toContain(rel);
    });

    it('fails when an api-key allowlist entry names a file that no longer exists', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const gone = 'apps/client/pages/api/deleted.ts';
      fs.writeFileSync(apiKeyAllowlist, `# header\n${gone}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('no longer exist');
      expect(r.stdout).toContain(gone);
    });

    it('fails on both scans in one run', () => {
      const { dir, v1Dir } = makeTree();
      const v1Rel = writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const outRel = writeApiHandler(dir, 'foo.ts', API_KEY);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(v1Rel);
      expect(r.stdout).toContain(outRel);
    });
  });

  describe('allowlist', () => {
    it('does not flag an allowlisted path', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'static-exception.ts', VIOLATING);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('reports stale allowlist entries that no longer need exemption (exits 0)', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const rel = writeHandler(v1Dir, 'now-clean.ts', EXEMPT);
      fs.writeFileSync(allowlist, `# header\n${rel}\n`, 'utf8');
      // Stale entries alone must not trigger exit 1.
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain('scripts/contract-gate-allowlist.txt');
      expect(r.stdout).not.toContain('contract-gate-api-key-allowlist.txt');
      expect(r.stdout).toContain(rel);
    });

    it('reports a stale entry and still fails on a new violator in the same run', () => {
      const { dir, v1Dir, allowlist } = makeTree();
      const staleRel = writeHandler(v1Dir, 'now-clean.ts', EXEMPT);
      const newRel = writeHandler(v1Dir, 'new-bad.ts', VIOLATING);
      fs.writeFileSync(allowlist, `# header\n${staleRel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain(staleRel);
      expect(r.stdout).toContain('ERROR');
      expect(r.stdout).toContain(newRel);
    });

    it('emits a GitHub Actions ::error:: annotation for new violators', () => {
      const { dir, v1Dir } = makeTree();
      writeHandler(v1Dir, 'bad.ts', VIOLATING);
      const r = runGuard(dir);
      expect(r.stdout).toContain('::error::');
    });
  });

  describe('function-url contract scan', () => {
    const RAW_WORKER_HANDLER = `export const handler = async () => ({ statusCode: 200, body: '' });\n`;
    const ROUTED_WORKER = `import { defineLambdaRoute } from './defineLambdaRoute';\nexport const handler = defineLambdaRoute(contract, async () => ({ statusCode: 200, body: {} }));\n`;
    // Nested objects and a template path: the scanner's brace matching has to survive both.
    const ROUTER_URL = '{ router: { instance: router, path: `${routePrefix}/api/ai/v1/tools` } }';

    it('flags a url: true Function whose handler is not built on defineLambdaRoute', () => {
      const { dir } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'raw.ts', fnDeclaration('apps/workers/src/raw.handler', 'true'));
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(handler);
      expect(r.stdout).toContain('::error::');
    });

    it('flags a url: { router } Function whose handler is not built on defineLambdaRoute', () => {
      const { dir } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'router.ts', fnDeclaration('apps/workers/src/raw.handler', ROUTER_URL));
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(handler);
    });

    // Acceptance criterion: the one Function URL that exists today passes with no allowlist entry.
    it('passes the CliToolHandler shape: a thin wrapper importing the routed module', () => {
      const { dir } = makeTree();
      writeInfra(dir, 'cli.ts', fnDeclaration('apps/workers/src/cli/tools.handler.handler', ROUTER_URL));
      writeWorker(dir, 'cli/tools.handler.ts', `import { run } from './tools';\nexport const handler = run;\n`);
      writeWorker(dir, 'cli/tools.ts', ROUTED_WORKER);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('passes a handler that calls defineLambdaRoute directly', () => {
      const { dir } = makeTree();
      writeWorker(dir, 'direct.ts', ROUTED_WORKER);
      writeInfra(dir, 'direct.ts', fnDeclaration('apps/workers/src/direct.handler', 'true'));
      expect(runGuard(dir).status).toBe(0);
    });

    it('does not scan a Function that declares no url', () => {
      const { dir } = makeTree();
      writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(
        dir,
        'plain.ts',
        `export const lambda = new sst.aws.Function('Lambda', {\n  handler: 'apps/workers/src/raw.handler',\n});\n`
      );
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('flags a handler that imports only a helper from the adapter', () => {
      const { dir } = makeTree();
      const handler = writeWorker(
        dir,
        'cli/helper.ts',
        `import { internalErrorResult } from '@workers/cli/defineLambdaRoute';\nexport const handler = () => internalErrorResult('x');\n`
      );
      writeWorker(
        dir,
        'cli/defineLambdaRoute.ts',
        `export function defineLambdaRoute(c: unknown, f: unknown) { return f; }\n`
      );
      writeInfra(dir, 'helper.ts', fnDeclaration('apps/workers/src/cli/helper.handler', 'true'));
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(handler);
    });

    it('lists every violating handler, one per file', () => {
      const { dir } = makeTree();
      const a = writeWorker(dir, 'a.ts', RAW_WORKER_HANDLER);
      const b = writeWorker(dir, 'b.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'a.ts', fnDeclaration('apps/workers/src/a.handler', 'true'));
      writeInfra(dir, 'b.ts', fnDeclaration('apps/workers/src/b.handler', 'true'));
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(a);
      expect(r.stdout).toContain(b);
    });

    it('checks every Function in one infra file, not only the first', () => {
      const { dir } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeWorker(dir, 'direct.ts', ROUTED_WORKER);
      writeInfra(
        dir,
        'two.ts',
        fnDeclaration('apps/workers/src/direct.handler', 'true') +
          fnDeclaration('apps/workers/src/raw.handler', 'true').replace('lambda', 'second')
      );
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(handler);
    });

    it('refuses to report clean when a url Function has a computed handler', () => {
      const { dir } = makeTree();
      writeInfra(
        dir,
        'computed.ts',
        `export const lambda = new sst.aws.Function('Lambda', {\n  handler: pickHandler(),\n  url: true,\n});\n`
      );
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Could not scan infra');
      expect(r.stdout + r.stderr).toContain('::error::');
      expect(r.stdout).not.toContain('OK: No contract-gate violations.');
    });

    // Node exits 1 for a throw or a load error, which must not read as "violations: none".
    it.each([
      ['throws at load', `throw new Error('boom');\n`],
      ['has a syntax error', `const = ;\n`],
    ])('refuses to report clean when the helper %s', (_label, helper) => {
      const { dir } = makeTree();
      fs.copyFileSync(GUARD, path.join(dir, 'scripts', 'check-contract-gate.sh'));
      fs.writeFileSync(path.join(dir, 'scripts', 'check-function-url-contracts.mjs'), helper, 'utf8');
      writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'raw.ts', fnDeclaration('apps/workers/src/raw.handler', 'true'));
      const r = spawnSync(BASH, [path.join(dir, 'scripts', 'check-contract-gate.sh')], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Function URL contract scan failed');
      expect(r.stdout).not.toContain('OK: No contract-gate violations.');
    });

    it('exits 1 when infra/ is missing', () => {
      const { dir } = makeTree();
      fs.rmSync(path.join(dir, 'infra'), { recursive: true });
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Infra directory not found');
    });

    it('exits 1 when the function-url allowlist file is missing', () => {
      const { dir, functionUrlAllowlist } = makeTree();
      fs.rmSync(functionUrlAllowlist);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/ERROR.*Allowlist not found/);
    });

    it('passes a reason-annotated allowlisted handler', () => {
      const { dir, functionUrlAllowlist } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'raw.ts', fnDeclaration('apps/workers/src/raw.handler', 'true'));
      fs.writeFileSync(functionUrlAllowlist, `# header\n${handler}  # legacy, owns auth itself\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('OK');
    });

    it('reports a stale function-url entry as INFO and exits 0', () => {
      const { dir, functionUrlAllowlist } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', ROUTED_WORKER);
      writeInfra(dir, 'raw.ts', fnDeclaration('apps/workers/src/raw.handler', 'true'));
      fs.writeFileSync(functionUrlAllowlist, `# header\n${handler}  # ported\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain(handler);
    });

    it('fails when an allowlist entry names a file that no longer exists', () => {
      const { dir, functionUrlAllowlist } = makeTree();
      const gone = path.join('apps', 'workers', 'src', 'deleted.ts');
      fs.writeFileSync(functionUrlAllowlist, `# header\n${gone}  # removed\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('no longer exist');
      expect(r.stdout).toContain(gone);
    });

    it('fails on an allowlist entry with no reason', () => {
      const { dir, functionUrlAllowlist } = makeTree();
      const handler = writeWorker(dir, 'raw.ts', RAW_WORKER_HANDLER);
      writeInfra(dir, 'raw.ts', fnDeclaration('apps/workers/src/raw.handler', 'true'));
      fs.writeFileSync(functionUrlAllowlist, `# header\n${handler}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("needs a trailing '# reason'");
    });
  });

  describe('unmetered LLM ratchet', () => {
    const UNMETERED_LLM = `
const handler = baseApi({ requiredScopes: ['ai:generate'] }).post(async (req, res) => {
  const { modelId, llm } = await OperationsModelService.getOperationsModel();
  await llm.complete(modelId, [], {}, async () => {});
});
export default handler;
`.trimStart();
    const METERED_LLM = `
const handler = baseApi({ requiredScopes: ['ai:generate'] }).post(async (req, res) => {
  const operations = await OperationsModelService.getOperationsModel();
  const llm = meterCompletionBackend(operations.llm, createRequestCompletionMeter(req, 'x'), operations.modelInfo);
  await llm.complete(operations.modelId, [], {}, async () => {});
});
export default handler;
`.trimStart();
    const JWT_ONLY_LLM = UNMETERED_LLM.replace("{ requiredScopes: ['ai:generate'] }", "{ auth: 'jwtOnly' }");

    it('flags a key-accepting handler that calls an LLM without a billing seam', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'ai/unmetered.ts', UNMETERED_LLM);
      // Isolate scan 3: the handler is a known scan-2 exemption.
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('call an LLM without credit metering');
      expect(r.stdout).toContain(rel);
    });

    it('flags an unmetered LLM call in a v1 handler too', () => {
      const { dir, v1Dir } = makeTree();
      const rel = writeHandler(v1Dir, 'unmetered.ts', `${UNMETERED_LLM}// nextRouteForContract(contract)\n`);
      const r = runGuard(dir);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(rel);
    });

    it('passes a handler that meters its LLM call', () => {
      const { dir, apiKeyAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'ai/metered.ts', METERED_LLM);
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}\n`, 'utf8');
      const r = runGuard(dir);
      expect(r.status).toBe(0);
    });

    it('passes a jwtOnly handler that calls an LLM unmetered', () => {
      const { dir } = makeTree();
      writeApiHandler(dir, 'ai/spa-only.ts', JWT_ONLY_LLM);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
    });

    it('passes a baselined handler and reports it stale once metered', () => {
      const { dir, apiKeyAllowlist, unmeteredAllowlist } = makeTree();
      const rel = writeApiHandler(dir, 'ai/legacy.ts', UNMETERED_LLM);
      fs.writeFileSync(apiKeyAllowlist, `# header\n${rel}\n`, 'utf8');
      fs.writeFileSync(unmeteredAllowlist, `# header\n${rel}  # follow-up\n`, 'utf8');
      expect(runGuard(dir).status).toBe(0);

      writeApiHandler(dir, 'ai/legacy.ts', METERED_LLM);
      const r = runGuard(dir);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('INFO');
      expect(r.stdout).toContain('unmetered-llm-route-allowlist.txt');
    });
  });
});
