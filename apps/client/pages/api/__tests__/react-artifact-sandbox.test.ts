import { describe, it, expect } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '../react-artifact-sandbox';

interface Captured {
  res: NextApiResponse;
  headers: Record<string, string>;
  getStatus: () => number;
  getBody: () => string;
}

// Captures setHeader + status + send into plain objects (mirrors artifact-sandbox.test.ts).
function makeRes(): Captured {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let body = '';
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    status(code: number) {
      statusCode = code;
      return res;
    },
    send(payload: string) {
      body = payload ?? '';
      return res;
    },
    end(payload?: string) {
      if (payload !== undefined) body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  return { res, headers, getStatus: () => statusCode, getBody: () => body };
}

function makeReq(method: 'GET' | 'HEAD' | 'POST'): NextApiRequest {
  return { method } as unknown as NextApiRequest;
}

describe('GET /api/react-artifact-sandbox', () => {
  it('returns 200 with the sandbox shell that posts ready and accepts a render message', () => {
    const { res, getStatus, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toContain('react-sandbox-ready');
    expect(getBody()).toContain('react-artifact-render');
  });

  it('sets text/html content type', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Type']).toContain('text/html');
  });

  // recharts' UMD externalizes prop-types and React 18's UMD no longer ships the PropTypes
  // global, so prop-types must load as a BASE script before any on-demand recharts load - else
  // recharts' factory throws at init and require() reports 'Module "recharts" is not available'.
  it('loads prop-types as a base script so recharts (and other UMD libs) can initialize', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getBody()).toMatch(/<script src="https:\/\/unpkg\.com\/prop-types@[\d.]+\/prop-types\.min\.js"><\/script>/);
  });

  // Parity with publish (transpileReactArtifact.ts): the inert transform must unwrap BOTH
  // `export default X` and `export { X as default }`. Without the second, that form survives into
  // this classic script as a parse error and blanks the preview - while it publishes+renders fine
  // (the divergence #544 introduced). Structural guard (the in-browser transform has no unit seam).
  it('unwraps the `export { X as default }` default-export form too (parity with publish)', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('__DEFAULT_EXPORT__ = '); // default-export unwrap present
    expect(body).toContain('as\\s+default'); // ...and the `export { X as default }` rewrite
  });

  // Parity with publish: lucide icons must be built from lucide's node-array format via
  // React.createElement children, NOT dangerouslySetInnerHTML (which injected the array as a
  // string -> invisible icons). Structural guard (the shim lives in the template string).
  it('renders lucide icons from the node-array format, not dangerouslySetInnerHTML', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('React.createElement(entry[0]');
    expect(body).toContain('Array.isArray');
    expect(body).not.toContain('dangerouslySetInnerHTML');
  });

  // Parity with the publish transpiler's import rewriting: namespace (import * as d3) and mixed
  // default+named (import Foo, { bar }) must be handled, else they emit invalid require() code.
  it('handles namespace and mixed default+named imports (parity with publish)', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('\\*\\s+as\\s+(\\w+)'); // namespace-import rewrite
    expect(body).toContain('(\\w+)\\s*,\\s*(\\{'); // mixed default+named rewrite
  });

  // This route's OWN response-header CSP grants 'unsafe-eval' in
  // script-src so Babel/new Function work, WITHOUT the app-origin CSP (proxy.ts) ever
  // carrying it. If a future change drops it from here, React artifacts break - pin it.
  it('grants unsafe-eval in script-src via the response-header CSP', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    const csp = headers['Content-Security-Policy'];
    expect(csp).toBeTruthy();
    expect(csp).toMatch(/script-src [^;]*'unsafe-eval'/);
  });

  it('sets connect-src none so artifact content cannot exfiltrate', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Security-Policy']).toContain("connect-src 'none'");
  });

  it('sets object-src none and frame-src none', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['Content-Security-Policy']).toContain("object-src 'none'");
    expect(headers['Content-Security-Policy']).toContain("frame-src 'none'");
  });

  it('sets X-Frame-Options, X-XSS-Protection, X-Content-Type-Options', () => {
    const { res, headers } = makeRes();
    handler(makeReq('GET'), res);
    expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(headers['X-XSS-Protection']).toBe('1; mode=block');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('responds to HEAD with headers but no body', () => {
    const { res, getStatus, getBody, headers } = makeRes();
    handler(makeReq('HEAD'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toBe('');
    expect(headers['Content-Security-Policy']).toBeTruthy();
  });

  it('ships the multi-file (relative-import) guard with a clear message', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    expect(getBody()).toContain('Multi-file artifacts are not supported yet');
  });

  it('ships the eval-free (inert) execution path gated on mode', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain("mode === 'inert'"); // M3 branch present
    expect(body).toContain('__artifactRequire'); // inline-script handoff (no new Function)
  });

  // Regression: the JSX transform MUST pin the classic runtime.
  // @babel/standalone 8.x defaults preset-react to the AUTOMATIC runtime, which injects
  // `import { jsx } from "react/jsx-runtime"` into the output. The sandbox runs that output
  // as a classic <script>/new Function with React as a global (no module loader), so an
  // injected top-level import throws "Cannot use import statement outside a module" and
  // breaks EVERY React artifact render. Classic runtime emits React.createElement instead.
  it('pins the classic JSX runtime so Babel never injects a react/jsx-runtime import', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain("runtime: 'classic'"); // explicit pin present
    // Must NOT use the bare default (which is automatic in Babel 8 -> injects an import).
    expect(body).not.toMatch(/presets:\s*\['react'\]/);
  });

  // Regression: the transform MUST include preset-typescript (the assistant emits TS by default:
  // types, generics, interfaces). Structural guard - the in-browser transform has no unit seam, so
  // assert the served shell wires it. Must stay in sync with transpileReactArtifact.ts (publish).
  it('includes the typescript preset and a .tsx filename so TS artifacts transpile', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain("'typescript'"); // preset-typescript strips TS before the JSX transform
    expect(body).toContain("filename: 'component.tsx'"); // TSX detected via extension
  });

  // Regression: TS type-only imports (`import type ...`, inline `{ type X }`) carry no runtime
  // binding and must be stripped BEFORE the regex require-rewrite, else they emit invalid
  // `const { type X } = ...`. Structural guard (in-browser transform has no unit seam); mirrors
  // stripTypeOnlyImports in the publish transpiler (transpileReactArtifact.ts).
  it('strips TS type-only imports before rewriting to require()', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const body = getBody();
    expect(body).toContain('withoutTypeImports'); // the strip pass is wired ahead of the rewrite
    expect(body).toContain('import\\s+type\\s+'); // whole-clause type-only import removal
  });

  // Regression guard: a literal `</script>` inside a JS comment in the
  // inline <script> block terminates script data early (the HTML tokenizer doesn't parse
  // JS), truncating the script (-> "Unexpected end of input") and dumping the rest of the
  // source as visible body text, breaking EVERY React artifact render. The served HTML
  // must never contain a literal `</script>` inside script data: reword the comment/string
  // or split the sequence (e.g. '</scr' + 'ipt>'). A backslash escape does NOT work:
  // the shell is built by a JS template literal, which collapses `<\/script>` back to
  // `</script>` before it reaches the browser (see route comment).
  it('contains no premature </script> that would truncate the inline sandbox script', () => {
    const { res, getBody } = makeRes();
    handler(makeReq('GET'), res);
    const html = getBody();
    // Simulate the HTML tokenizer's script-data state: once inside <script ...>, ONLY a
    // literal </script> exits the block - JS comments/strings are NOT understood. Walk the
    // paired blocks and count how many </script> get consumed as legitimate terminators.
    let i = 0;
    let consumed = 0;
    while (true) {
      const open = html.indexOf('<script', i);
      if (open === -1) break;
      const openEnd = html.indexOf('>', open);
      expect(openEnd).toBeGreaterThan(-1);
      const close = html.indexOf('</script>', openEnd);
      expect(close).toBeGreaterThan(-1); // every opened block must close
      consumed++;
      i = close + '</script>'.length;
    }
    // Every </script> in the document must have been consumed as a terminator. A leftover
    // closer (e.g. one buried in a comment) means a block ended early - the exact bug.
    const totalCloses = (html.match(/<\/script>/gi) || []).length;
    expect(consumed).toBe(totalCloses);
    expect(consumed).toBeGreaterThan(0);
  });

  it('rejects non-GET/HEAD methods with 405', () => {
    const { res, getStatus, headers } = makeRes();
    handler(makeReq('POST'), res);
    expect(getStatus()).toBe(405);
    expect(headers['Allow']).toBe('GET, HEAD');
  });
});
