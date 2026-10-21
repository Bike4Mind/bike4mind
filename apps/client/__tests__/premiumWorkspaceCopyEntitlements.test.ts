import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Guard for the workspace copy-grant contribution: overlays declare which extra entitlements may keep
 * a fork/snip/clone inside a workspace (see `PremiumWorkspaceCopyEntitlements`), and the server
 * enforces whatever lands in the generated table - so the validator is the control on its shape, and
 * on the rule that every grant is also admitted by the workspace's own gates (`workspaceGateEntitlements`).
 *
 * Runs the real script inside a sandbox tree, since its paths derive from its own
 * location: sandbox/apps/client/scripts/ next to sandbox/packages/premium/.
 */

const REAL_SCRIPT = join(__dirname, '../scripts/generate-premium-glue.mjs');
const GENERATED = 'app/premium-generated/premiumWorkspaceCopyEntitlements.generated.ts';

let sandbox: string;
let script: string;
let clientRoot: string;

function writeOverlay(dir: string, contributions: Record<string, unknown>) {
  const overlayDir = join(sandbox, 'packages/premium', dir);
  mkdirSync(overlayDir, { recursive: true });
  writeFileSync(
    join(overlayDir, 'package.json'),
    JSON.stringify({ name: `@bike4mind/premium-${dir}`, b4mContributions: contributions })
  );
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
  sandbox = mkdtempSync(join(tmpdir(), 'b4m-copygrants-test-'));
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
});

describe('premium workspace copy entitlements', () => {
  it('emits the empty form when no overlay declares any', () => {
    writeOverlay('silent', {});

    const generated = generate();

    expect(generated).toContain('premiumWorkspaceCopyEntitlements: PremiumWorkspaceCopyEntitlements = {}');
  });

  it('emits the declared grants for an overlay that is NOT linked into node_modules', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { 'alpha-space': ['Base:Pro'] },
      workspaceGateEntitlements: { 'alpha-space': ['alpha:pro', 'base:pro'] },
    });

    const generated = generate();

    // Keys are lowercased to match the resolved (normalized) entitlement list they are compared to.
    expect(generated).toContain(`"alpha-space": ["base:pro"]`);
    // Data only - the package is never imported to read its own grants.
    expect(generated).not.toContain('@bike4mind/premium-alpha');
  });

  it('merges grants for the same workspace across overlays and drops duplicates', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { shared: ['base:pro', 'alpha:pro'] },
      workspaceGateEntitlements: { shared: ['base:pro', 'alpha:pro'] },
    });
    writeOverlay('beta', {
      workspaceCopyEntitlements: { shared: ['base:pro', 'beta:pro'], other: ['beta:pro'] },
      workspaceGateEntitlements: { shared: ['base:pro', 'beta:pro'], other: ['beta:pro'] },
    });

    const generated = generate();

    expect(generated).toContain(`"shared": ["base:pro", "alpha:pro", "beta:pro"]`);
    expect(generated).toContain(`"other": ["beta:pro"]`);
  });

  it('rejects a non-object declaration', () => {
    writeOverlay('malformed', { workspaceCopyEntitlements: ['base:pro'] });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('expected an object of workspace id -> entitlement keys');
  });

  it('rejects a workspace id outside the safe charset', () => {
    writeOverlay('proto', { workspaceCopyEntitlements: JSON.parse('{"__proto__": ["base:pro"]}') });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceCopyEntitlements workspace id');
  });

  it('rejects keys that are not an array of entitlement keys', () => {
    writeOverlay('loose', { workspaceCopyEntitlements: { space: 'base:pro' } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceCopyEntitlements: { space: [''] } });
    expect(runCodegen().status).toBe(1);

    writeOverlay('loose', { workspaceCopyEntitlements: { space: [`x"]; process.exit(0); //`] } });
    const { status, stderr } = runCodegen();
    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceCopyEntitlements keys');
  });
});

describe('premium workspace copy entitlements - gate cross-check', () => {
  // A grant whose key the workspace's own gates refuse strands the copy: it leaves the main list
  // and its owner cannot open it where it went. Codegen cannot read those gates, so the package
  // declares them, and the build fails on any grant they do not admit.

  it('passes a grant the same package declares its workspace gates admit, in any case', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: ['base:pro'] },
      workspaceGateEntitlements: { space: ['ALPHA:PRO', 'Base:Pro'] },
    });

    expect(generate()).toContain(`"space": ["base:pro"]`);
  });

  it('fails a grant with no gate declaration for its workspace, naming the key', () => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { space: ['base:pro'] } });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain(`grants ["base:pro"] for workspace "space"`);
    expect(stderr).toContain('does not admit them');
  });

  it('fails a grant the declared gates do not admit, even when the others pass', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: ['alpha:pro', 'base:pro'] },
      workspaceGateEntitlements: { space: ['alpha:pro'], elsewhere: ['base:pro'] },
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain(`grants ["base:pro"] for workspace "space"`);
  });

  it("does not take another package's gate declaration on the granting package's behalf", () => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { space: ['base:pro'] } });
    writeOverlay('beta', { workspaceGateEntitlements: { space: ['base:pro'] } });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('package "@bike4mind/premium-alpha"');
  });

  it('accepts a gate declaration on its own and grants nothing from it', () => {
    writeOverlay('alpha', { workspaceGateEntitlements: { space: ['base:pro'] } });

    expect(generate()).toContain('premiumWorkspaceCopyEntitlements: PremiumWorkspaceCopyEntitlements = {}');
  });

  it('validates the gate declaration with the same shape rules as the grants', () => {
    writeOverlay('alpha', { workspaceGateEntitlements: ['base:pro'] });
    let result = runCodegen();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid workspaceGateEntitlements from package');

    writeOverlay('alpha', { workspaceGateEntitlements: { space: [`x"]; //`] } });
    result = runCodegen();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('invalid workspaceGateEntitlements keys');
  });
});

describe('premium workspace copy entitlements - grant displays', () => {
  // An object-form grant also says how the workspace is shown to a user who reaches it only through
  // that key. The key half joins the grant table like a bare string; the display half is emitted on
  // its own, and both of its values reach the UI and the router verbatim.
  const DISPLAYS = 'app/premium-generated/premiumWorkspaceGrantDisplays.generated.ts';
  const displays = () => readFileSync(join(clientRoot, DISPLAYS), 'utf8');
  const gates = { space: ['alpha:pro', 'partner:pro', 'other:pro'] };

  it('emits the empty display form when no grant declares one', () => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { space: ['partner:pro'] }, workspaceGateEntitlements: gates });

    generate();

    expect(displays()).toContain('premiumWorkspaceGrantDisplays: PremiumWorkspaceGrantDisplays = {}');
  });

  it('grants an object-form key like a bare one and emits its display separately', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: {
        space: ['alpha:pro', { key: 'Partner:Pro', label: 'Partner Desk', sessionHref: '/desk?session={sessionId}' }],
      },
      workspaceGateEntitlements: gates,
    });

    expect(generate()).toContain(`"space": ["alpha:pro", "partner:pro"]`);
    expect(displays()).toContain(
      `"space": [{"key":"partner:pro","label":"Partner Desk","sessionHref":"/desk?session={sessionId}"}]`
    );
    expect(displays()).not.toContain('@bike4mind/premium-alpha');
  });

  it('omits sessionHref when a display declares only a label', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: [{ key: 'partner:pro', label: 'Partner Desk' }] },
      workspaceGateEntitlements: gates,
    });

    generate();

    expect(displays()).toContain(`"space": [{"key":"partner:pro","label":"Partner Desk"}]`);
  });

  it('still requires the gates to admit an object-form key', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: [{ key: 'stray:pro', label: 'Stray' }] },
      workspaceGateEntitlements: gates,
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain(`grants ["stray:pro"] for workspace "space"`);
  });

  it.each([
    ['an unknown field', { key: 'partner:pro', label: 'Partner', icon: 'x' }, 'unknown field'],
    ['a missing label', { key: 'partner:pro' }, 'label undefined'],
    ['a blank label', { key: 'partner:pro', label: '  ' }, 'label "  "'],
    ['a padded label', { key: 'partner:pro', label: ' Partner' }, 'one trimmed line'],
    ['a multi-line label', { key: 'partner:pro', label: 'Partner\nDesk' }, 'one trimmed line'],
    ['an over-long label', { key: 'partner:pro', label: 'x'.repeat(65) }, 'at most 64 characters'],
    ['a malformed key', { key: `x"]; //`, label: 'Partner' }, 'is not an entitlement key'],
  ])('rejects a display with %s', (_name, entry, message) => {
    writeOverlay('alpha', { workspaceCopyEntitlements: { space: [entry] }, workspaceGateEntitlements: gates });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain(message);
  });

  it.each([
    ['no slot', '/desk'],
    ['two slots', '/desk/{sessionId}/{sessionId}'],
    ['an absolute URL', 'https://example.com/desk?session={sessionId}'],
    ['a protocol-relative URL', '//example.com/desk?session={sessionId}'],
    ['no route before the slot', '/{sessionId}'],
    ['the slot opening the path', '/{sessionId}/desk'],
    ['a quote', `/desk?session={sessionId}'`],
    ['whitespace', '/desk ?session={sessionId}'],
    ['a fragment', '/desk#{sessionId}'],
  ])('rejects a sessionHref with %s', (_name, sessionHref) => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: [{ key: 'partner:pro', label: 'Partner', sessionHref }] },
      workspaceGateEntitlements: gates,
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('must be a same-origin path');
  });

  it('accepts a sessionHref whose slot is a path segment', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: {
        space: [{ key: 'partner:pro', label: 'Partner', sessionHref: '/desk/{sessionId}' }],
      },
      workspaceGateEntitlements: gates,
    });

    generate();

    expect(displays()).toContain(`"sessionHref":"/desk/{sessionId}"`);
  });

  it('refuses a key that one package displays twice', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: {
        space: [
          { key: 'partner:pro', label: 'Partner' },
          { key: 'PARTNER:PRO', label: 'Partner Desk' },
        ],
      },
      workspaceGateEntitlements: gates,
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('declares a label more than once');
  });

  it('does not accept the object form in the gate declaration', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: ['partner:pro'] },
      workspaceGateEntitlements: { space: [{ key: 'partner:pro', label: 'Partner' }] },
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('invalid workspaceGateEntitlements keys');
  });

  it('merges displays across overlays in package order and drops an identical repeat', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: [{ key: 'partner:pro', label: 'Partner' }] },
      workspaceGateEntitlements: gates,
    });
    writeOverlay('beta', {
      workspaceCopyEntitlements: {
        space: [
          { key: 'partner:pro', label: 'Partner' },
          { key: 'other:pro', label: 'Other' },
        ],
      },
      workspaceGateEntitlements: gates,
    });

    generate();

    expect(displays()).toContain(
      `"space": [{"key":"partner:pro","label":"Partner"}, {"key":"other:pro","label":"Other"}]`
    );
  });

  it('fails when two overlays show the same key differently, naming both', () => {
    writeOverlay('alpha', {
      workspaceCopyEntitlements: { space: [{ key: 'partner:pro', label: 'Partner' }] },
      workspaceGateEntitlements: gates,
    });
    writeOverlay('beta', {
      workspaceCopyEntitlements: { space: [{ key: 'partner:pro', label: 'Partner', sessionHref: '/b?s={sessionId}' }] },
      workspaceGateEntitlements: gates,
    });

    const { status, stderr } = runCodegen();

    expect(status).toBe(1);
    expect(stderr).toContain('"@bike4mind/premium-alpha" and "@bike4mind/premium-beta"');
  });
});
