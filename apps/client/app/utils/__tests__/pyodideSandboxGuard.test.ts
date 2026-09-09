import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard for Python artifact execution, sibling of reactArtifactSandboxGuard.
 *
 * Python artifacts used to run in a Worker created from the app origin. A Worker inherits its
 * creator's origin, and Pyodide always exposes the `js` module, so guest Python had a
 * same-origin, same-site `fetch` - enough to POST the host-only `SameSite=Strict` refresh cookie
 * to /api/auth/refreshToken and mint the viewer's session. Execution now happens inside the
 * opaque-origin /api/pyodide-sandbox frame.
 *
 * The regression this locks is narrow and easy to reintroduce: a single `new Worker(...)` back
 * on the app origin, or a single `allow-same-origin` token, restores the hole completely, and
 * neither would fail any behavioural test - Python would keep working exactly as before.
 */

// apps/client/app/utils/__tests__ -> apps/client is three levels up.
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const MANAGER_FILE = 'app/utils/pyodideManager.ts';
const ROUTE_FILE = 'pages/api/pyodide-sandbox.ts';
const WORKER_BODY_FILE = 'app/workers/pyodide/sandboxWorkerBody.ts';
const GUARDED_FILES = [MANAGER_FILE, ROUTE_FILE, WORKER_BODY_FILE];

const read = (rel: string): string => readFileSync(resolve(CLIENT_ROOT, rel), 'utf8');

/**
 * Source with comments removed. These files necessarily DISCUSS the tokens and APIs they must
 * not use - a guard that greps raw text fires on its own explanation, so it would be weakened
 * or deleted the first time someone documented the rule properly.
 */
const readCode = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('Python artifact sandbox guard', () => {
  it('all guarded files exist (guards against a silently-broken path list)', () => {
    for (const rel of GUARDED_FILES) {
      expect(existsSync(resolve(CLIENT_ROOT, rel)), `${rel} not found - update pyodideSandboxGuard paths`).toBe(true);
    }
  });

  it('the old app-origin worker module is gone', () => {
    // Its mere existence would mean a bundled, same-origin-constructible Pyodide worker.
    expect(existsSync(resolve(CLIENT_ROOT, 'app/workers/pyodide/pyodide.worker.ts'))).toBe(false);
  });

  it('the manager never constructs a Worker on the app origin', () => {
    // The only `new Worker` for Python lives in the sandbox shell, inside the opaque frame.
    expect(readCode(MANAGER_FILE)).not.toMatch(/new\s+Worker\s*\(/);
  });

  it('the manager frames the sandbox without allow-same-origin', () => {
    const code = readCode(MANAGER_FILE);
    expect(code).toContain("'/api/pyodide-sandbox'");
    expect(code).not.toContain('allow-same-origin');
    // allow-scripts alone: anything more is a deliberate widening that should fail here first.
    expect(code).toMatch(/PYODIDE_SANDBOX_TOKENS\s*=\s*'allow-scripts'/);
  });

  it('no Python surface reintroduces a blob: or srcdoc execution path', () => {
    // A blob:/srcdoc document inherits the creating document's CSP and cannot be given a
    // stricter origin, which is why the route exists at all.
    const code = readCode(MANAGER_FILE);
    expect(code).not.toContain('srcdoc');
    expect(code).not.toMatch(/createObjectURL/);
  });

  it('the route keeps the sandbox unable to reach the app', () => {
    const code = readCode(ROUTE_FILE);
    expect(code).toContain('"default-src \'none\'"');
    expect(code).toContain('connect-src');
    // 'self' inside the sandbox CSP would be the app origin - the exact reach being removed.
    expect(code).not.toMatch(/connect-src[^`\n]*'self'/);
  });

  it('the worker body reaches the network only through the Pyodide distribution', () => {
    // The body runs guest Python. It must not itself open a channel back to the app; the CSP
    // is the enforcement, but a fetch here would mean someone intended one.
    const code = readCode(WORKER_BODY_FILE);
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/XMLHttpRequest/);
  });
});
