import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the per-route notebook sidenav slot. The slot used to be a single
 * component that core matched against a hardcoded '/opti', so a second overlay's nav was
 * warned about and dropped. Now each overlay names the route its nav owns, and codegen
 * emits one entry per overlay.
 *
 * The route path is interpolated raw into a generated string literal, so its validator is
 * a build-time control, not a nicety - the rejection cases below are the control.
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumNotebookSidenavs.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

// Hydrate the overlay AND link it: bare-specifier glue (this slot included) emits the
// absent form for a package that is not resolvable from apps/client, so an unlinked
// sandbox overlay would never reach the generator at all.
function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const name = `@bike4mind/premium-${dir}`;
  const manifest = JSON.stringify({ name, b4mContributions: contributions });

  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(join(overlayDir, 'package.json'), manifest);

  const linkDir = join(sandbox, 'node_modules', name);
  mkdirSync(linkDir, { recursive: true });
  writeFileSync(join(linkDir, 'package.json'), manifest);
}

function runCodegen() {
  // CI is forced off: the script hard-fails a hydrated-but-unlinked tree when
  // CI === 'true', and these overlays are deliberately never linked.
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, CI: '' } });
}

function generate() {
  const result = runCodegen();
  expect(result.status, result.stderr).toBe(0);
  return readFileSync(join(clientRoot, GENERATED), 'utf8');
}

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-sidenav-test-'));
  clientRoot = join(sandbox, 'apps/client');
  script = join(clientRoot, 'scripts/generate-premium-glue.mjs');

  mkdirSync(join(clientRoot, 'scripts'), { recursive: true });
  cpSync(REAL_SCRIPT, script);
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(sandbox, 'packages/premium'), { recursive: true, force: true });
  rmSync(join(sandbox, 'node_modules'), { recursive: true, force: true });
  mkdirSync(join(sandbox, 'packages/premium'), { recursive: true });
});

describe('notebook sidenav codegen', () => {
  it('emits the empty array when no overlay contributes one', () => {
    writeOverlay('plain', { llmToolsExport: '@bike4mind/premium-plain/llm-tools' });
    expect(generate()).toContain('premiumNotebookSidenavs: PremiumNotebookSidenavEntry[] = []');
  });

  it('emits one entry per overlay, each keyed by its own route', () => {
    // The point of the change: before this, the second overlay here was dropped with a warning.
    writeOverlay('alpha', {
      notebookSidenavExport: { path: '/alpha', exportFrom: '@bike4mind/premium-alpha/sidenav' },
    });
    writeOverlay('beta', { notebookSidenavExport: { path: '/beta', exportFrom: '@bike4mind/premium-beta/sidenav' } });

    // Directory order decides which overlay gets index 0, so read the binding back out
    // rather than assume it - what matters is that each route points at its own module.
    const out = generate();
    const moduleFor = (path: string) => {
      const binding = out.match(new RegExp(`\\{ path: '${path}', component: (Sidenav\\d+) \\}`))?.[1];
      expect(binding, `no entry for ${path}`).toBeTruthy();
      return out.match(new RegExp(`const ${binding} = dynamic\\(\\(\\) => import\\('([^']+)'\\)`))?.[1];
    };

    expect(moduleFor('/alpha')).toBe('@bike4mind/premium-alpha/sidenav');
    expect(moduleFor('/beta')).toBe('@bike4mind/premium-beta/sidenav');
    // Still lazy, so one overlay's surface is not in the other's bundle.
    expect(out).toContain('{ ssr: false }');
  });

  it('keeps the legacy bare-specifier form working on /opti, with a deprecation warning', () => {
    writeOverlay('legacy', { notebookSidenavExport: '@bike4mind/premium-legacy/sidenav' });

    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('deprecated');
    expect(readFileSync(join(clientRoot, GENERATED), 'utf8')).toContain("{ path: '/opti', component: Sidenav0 }");
  });

  it('warns when two overlays claim the same route, keeps the first, and emits only that one', () => {
    writeOverlay('aaa', { notebookSidenavExport: { path: '/dup', exportFrom: '@bike4mind/premium-aaa/sidenav' } });
    writeOverlay('bbb', { notebookSidenavExport: { path: '/dup', exportFrom: '@bike4mind/premium-bbb/sidenav' } });

    const result = runCodegen();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('both contribute a notebook sidenav for "/dup"');

    // The loser is dropped, not merely out-matched at runtime: a dead `dynamic()` import
    // would pull its module into the route's chunk graph for a nav nothing can render.
    const out = readFileSync(join(clientRoot, GENERATED), 'utf8');
    expect(out.match(/path: '\/dup'/g)).toHaveLength(1);
    expect(out).toContain("'@bike4mind/premium-aaa/sidenav'");
    expect(out).not.toContain('@bike4mind/premium-bbb/sidenav');
  });

  it.each([
    ['surface', 'no leading slash'],
    ["/surface'; alert(1); '", 'quote that would break out of the string literal'],
    ['/surface\nx', 'newline'],
    ['/../etc', 'relative segment'],
    [42, 'not a string'],
    // The three shapes no real `pathname` can equal. `/` matters most: an overlay claiming
    // it would take core's home-route sidenav.
    ['/', 'bare root'],
    ['/surface/', 'trailing slash'],
    ['//surface', 'empty first segment'],
  ])('rejects %j as a route path (%s)', (path: unknown) => {
    writeOverlay('bad', { notebookSidenavExport: { path, exportFrom: '@bike4mind/premium-bad/sidenav' } });

    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('is not an origin-relative route path');
  });

  it('rejects a non-bare exportFrom', () => {
    writeOverlay('bad', { notebookSidenavExport: { path: '/bad', exportFrom: '../../etc/passwd' } });

    const result = runCodegen();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('notebookSidenavExport.exportFrom');
  });
});
