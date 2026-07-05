import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard for the React-artifact CSP decision. The fix moved React
 * rendering off `blob:` URLs (which inherit the app CSP and broke in prod) onto a dedicated
 * route whose own header CSP grants 'unsafe-eval' in an opaque-origin iframe. This test locks
 * the whole foot-gun CLASS so a future change can't silently reopen the hole for a new artifact
 * type - pure string parsing, no rendering, no AWS.
 *
 * It enforces:
 *  (a) no artifact iframe ever gets `allow-same-origin` (that's the single attribute between
 *      eval-in-an-opaque-sandbox and full app-origin compromise);
 *  (b) the in-app React surfaces never reintroduce a blob:/srcdoc artifact-render path -
 *      they must go through the blessed /api/react-artifact-sandbox route;
 *  (c) the route keeps its eval scoped (unsafe-eval present, connect-src 'none').
 */

// apps/client/app/utils/__tests__ -> apps/client is three levels up.
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// In-app artifact viewers that render untrusted artifact content in an iframe.
const ARTIFACT_VIEWER_FILES = [
  'app/components/GenAI/InlineArtifactPreview.tsx',
  'app/components/Knowledge/ReactArtifactViewer.tsx',
  'app/components/Knowledge/HtmlArtifactViewer.tsx',
];

// The React surfaces specifically - these must render via the route, never via blob:/srcdoc.
const REACT_SURFACE_FILES = [
  'app/components/GenAI/InlineArtifactPreview.tsx',
  'app/components/Knowledge/ReactArtifactViewer.tsx',
];

const ROUTE_FILE = 'pages/api/react-artifact-sandbox.ts';

const read = (rel: string): string => readFileSync(resolve(CLIENT_ROOT, rel), 'utf8');

describe('React artifact sandbox guard', () => {
  it('all guarded files exist (guards against a silently-broken path list)', () => {
    for (const rel of [...ARTIFACT_VIEWER_FILES, ROUTE_FILE]) {
      expect(existsSync(resolve(CLIENT_ROOT, rel)), `${rel} not found — update reactArtifactSandboxGuard paths`).toBe(
        true
      );
    }
  });

  it('(a) no artifact iframe grants allow-same-origin', () => {
    // Inspect actual `sandbox="..."` attribute values, not prose - a comment mentioning
    // allow-same-origin must not trip the guard.
    const SANDBOX_ATTR = /sandbox\s*=\s*["']([^"']*)["']/g;
    const offenders: string[] = [];
    let attrCount = 0;
    for (const rel of ARTIFACT_VIEWER_FILES) {
      for (const m of read(rel).matchAll(SANDBOX_ATTR)) {
        attrCount++;
        if (m[1].includes('allow-same-origin')) offenders.push(`${rel}: sandbox="${m[1]}"`);
      }
    }
    // Canary: if this finds no sandbox attributes the regex broke - fail loudly rather than pass vacuously.
    expect(attrCount, 'found no sandbox="..." attributes — the regex or file list is broken').toBeGreaterThanOrEqual(3);
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These artifact iframes add 'allow-same-origin', which lets eval'd artifact code reach app ` +
            `cookies/localStorage/token — the exact escalation #9403's design forbids:\n` +
            `${offenders.map(o => `  - ${o}`).join('\n')}`
    ).toEqual([]);
  });

  it('(b) React surfaces render via the sandbox route, not blob:/srcdoc', () => {
    const offenders = REACT_SURFACE_FILES.flatMap(rel => {
      const src = read(rel);
      const hits: string[] = [];
      if (src.includes('createObjectURL')) hits.push(`${rel} uses createObjectURL (blob: render path — #9403)`);
      if (/\bsrcdoc\b/.test(src)) hits.push(`${rel} uses srcdoc (inherits app CSP — #9403)`);
      if (!src.includes('useReactArtifactSandbox')) hits.push(`${rel} no longer renders via useReactArtifactSandbox`);
      return hits;
    });
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `React artifact rendering must go through /api/react-artifact-sandbox (useReactArtifactSandbox). ` +
            `A blob:/srcdoc path inherits the app CSP and reopens #9403:\n${offenders.map(o => `  - ${o}`).join('\n')}`
    ).toEqual([]);
  });

  it('(c) the sandbox route keeps unsafe-eval scoped to itself with connect-src none', () => {
    const route = read(ROUTE_FILE);
    expect(route, `${ROUTE_FILE} must grant 'unsafe-eval' in its own CSP (that is the whole fix)`).toContain(
      "'unsafe-eval'"
    );
    expect(route, `${ROUTE_FILE} must keep connect-src 'none' so artifact code cannot exfiltrate`).toContain(
      "connect-src 'none'"
    );
  });
});
