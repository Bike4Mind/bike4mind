// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { extractRequiredScopesGate, methodBlocks, stripComments, tsFiles } from './scopeCoverageHelpers';

/**
 * Every `/api/projects` and `/api/agents` door gates API keys on that family's scope
 * (server/projects/projectScopes.ts, server/agents/agentScopes.ts). These routes used plain
 * `baseApi()`, so a key minted with any unrelated scope could still read and mutate them. A source
 * scan, not a runtime test: nothing at runtime fails when a new door simply omits `requiredScopes`.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and pulls
// the project into the server Lambda (eslint no-restricted-syntax guards it).
const API_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

type Family = {
  dir: string;
  prefix: 'PROJECTS' | 'AGENTS';
  assertNoun: 'Projects' | 'Agents';
  /** Pinned by hand so a write door mislabeled READ (or vice versa) fails here. */
  expectedGates: Record<string, string>;
};

const FAMILIES: Family[] = [
  {
    dir: 'projects',
    prefix: 'PROJECTS',
    assertNoun: 'Projects',
    expectedGates: {
      '[id]/members.ts': 'PROJECTS_WRITE_SCOPES',
      '[id]/systemPrompts/index.ts': 'PROJECTS_WRITE_SCOPES',
      '[id]/systemPrompts/toggle.ts': 'PROJECTS_WRITE_SCOPES',
      'removeNonExistintFiles.ts': 'PROJECTS_WRITE_SCOPES',
      '[id]/files.ts': 'PROJECTS_READ_OR_WRITE_SCOPES',
      '[id]/index.ts': 'PROJECTS_READ_OR_WRITE_SCOPES',
      '[id]/invites.ts': 'PROJECTS_READ_OR_WRITE_SCOPES',
      '[id]/sessions.ts': 'PROJECTS_READ_OR_WRITE_SCOPES',
      'index.ts': 'PROJECTS_READ_OR_WRITE_SCOPES',
    },
  },
  {
    dir: 'agents',
    prefix: 'AGENTS',
    assertNoun: 'Agents',
    expectedGates: {
      '[id]/embed-keys.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/enhance-field.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/generate-avatar.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/generate-description.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/generate-system-prompt.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/transfer-credits.ts': 'AGENTS_WRITE_SCOPES',
      'create-from-context.ts': 'AGENTS_WRITE_SCOPES',
      '[id]/index.ts': 'AGENTS_READ_OR_WRITE_SCOPES',
      '[id]/missions.ts': 'AGENTS_READ_OR_WRITE_SCOPES',
      'index.ts': 'AGENTS_READ_OR_WRITE_SCOPES',
    },
  },
];

// Every route in both trees declares its handler this way, so anchoring here keeps a dead gated
// `baseApi(...)` next to an ungated exported handler from passing.
const GATE_CALL = 'const handler = baseApi\\(';

const withoutStringLiterals = (source: string): string =>
  source.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`/g, "''");

/**
 * True when `body` calls `assertName(req` before its first `await`, so no repository or service
 * call can run for a key that lacks the scope. String literals are blanked first so a quoted
 * mention cannot stand in for the call.
 */
function assertsBeforeFirstAwait(body: string, assertName: string): boolean {
  const code = withoutStringLiterals(body);
  const callIndex = code.search(new RegExp(`\\b${assertName}\\(req\\b`));
  if (callIndex === -1) return false;
  const awaitIndex = code.search(/\bawait\b/);
  return awaitIndex === -1 || callIndex < awaitIndex;
}

describe.each(FAMILIES)('every /api/$dir door gates API keys on a $dir scope', family => {
  const familyDir = path.join(API_DIR, family.dir);
  // Normalized to forward slashes so expectedGates keys don't drift by platform path.sep.
  const routes = tsFiles(familyDir).map(
    file => [path.relative(familyDir, file).split(path.sep).join('/'), file] as const
  );

  it('finds the doors', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('pins a gate for exactly the doors that exist', () => {
    expect(routes.map(([relPath]) => relPath).sort()).toEqual(Object.keys(family.expectedGates).sort());
  });

  it.each(routes)('%s', (relPath, file) => {
    const rawSource = readFileSync(file, 'utf8');
    const gate = extractRequiredScopesGate(rawSource, family.prefix, GATE_CALL);
    expect(gate, `declare const handler = baseApi({ requiredScopes: ${family.prefix}_*_SCOPES })`).toBeDefined();
    expect(stripComments(rawSource), `${relPath} must export the gated handler`).toMatch(/export default handler\b/);

    const expectedGate = family.expectedGates[relPath];
    expect(
      expectedGate,
      `${relPath} has no expectedGates entry - add one so this route's scope is pinned`
    ).toBeDefined();
    expect(gate, `${relPath} must stay pinned to ${expectedGate}`).toBe(expectedGate);

    if (gate !== `${family.prefix}_READ_OR_WRITE_SCOPES`) return;
    // The route gate admits either scope, so each method must narrow to its own.
    const blocks = methodBlocks(stripComments(rawSource));
    // A read-or-write door serves both kinds; finding fewer means the splitter went blind to one.
    expect(
      blocks.some(({ method }) => method === 'get'),
      `${relPath}: no .get handler found`
    ).toBe(true);
    expect(
      blocks.some(({ method }) => method !== 'get'),
      `${relPath}: no write handler found`
    ).toBe(true);
    for (const { method, body } of blocks) {
      const isRead = method === 'get';
      const assertName = `assert${family.assertNoun}${isRead ? 'Read' : 'Write'}Scope`;
      expect(
        assertsBeforeFirstAwait(body, assertName),
        `.${method} on a read-or-write route must call ${assertName}(req) before its first await`
      ).toBe(true);
    }
  });
});

describe('the gate regex actually rejects a bad door', () => {
  it('sees a handler whose type argument nests generics', () => {
    const source = 'baseApi({}).get<Request<{}, {}, {}, { id: string }>>(async () => {}).put(async () => {});';
    expect(methodBlocks(source).map(({ method }) => method)).toEqual(['get', 'put']);
    expect(methodBlocks(source)[0].body).not.toMatch(/assertAgentsReadScope\(/);
  });

  it('fails a route with no requiredScopes at all', () => {
    const source = 'const handler = baseApi().get(async (req, res) => {});\nexport default handler;';
    expect(extractRequiredScopesGate(source, 'PROJECTS', GATE_CALL)).toBeUndefined();
  });

  it('ignores a requiredScopes mention living only in a comment', () => {
    const source = [
      '// requiredScopes: AGENTS_READ_SCOPES',
      '/* baseApi({ requiredScopes: AGENTS_READ_SCOPES }) */',
      'const handler = baseApi({}).get(async (req, res) => {});',
    ].join('\n');
    expect(extractRequiredScopesGate(source, 'AGENTS', GATE_CALL)).toBeUndefined();
  });

  it('does not accept the other family scope constant', () => {
    const source = 'const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(async () => {});';
    expect(extractRequiredScopesGate(source, 'AGENTS', GATE_CALL)).toBeUndefined();
  });

  it('flags a mixed door whose later method forgot its own assert', () => {
    const source = [
      'const handler = baseApi({ requiredScopes: AGENTS_READ_OR_WRITE_SCOPES })',
      '  .get(async (req, res) => { assertAgentsReadScope(req); })',
      '  .post(async (req, res) => { return res.json({}); });',
    ].join('\n');
    const post = methodBlocks(source).find(block => block.method === 'post');
    expect(post?.body).not.toMatch(/assertAgentsWriteScope\(/);
  });

  it('rejects a gated baseApi sitting next to an ungated exported handler', () => {
    const source = [
      'const other = baseApi({ requiredScopes: AGENTS_WRITE_SCOPES });',
      'const handler = baseApi().get(async (req, res) => {});',
      'export default handler;',
    ].join('\n');
    expect(extractRequiredScopesGate(source, 'AGENTS', GATE_CALL)).toBeUndefined();
  });

  it('accepts the assert as the first thing in a handler', () => {
    const body = '.put(async (req, res) => { assertAgentsWriteScope(req); await repo.update(); })';
    expect(assertsBeforeFirstAwait(body, 'assertAgentsWriteScope')).toBe(true);
  });

  it('rejects an assert placed after an await', () => {
    const body = '.put(async (req, res) => { await repo.update({}); assertAgentsWriteScope(req); })';
    expect(assertsBeforeFirstAwait(body, 'assertAgentsWriteScope')).toBe(false);
  });

  it('does not count an assert that only appears inside a string literal', () => {
    const body = ".get(async (req, res) => { const note = 'assertAgentsReadScope(req)'; return res.json({}); })";
    expect(assertsBeforeFirstAwait(body, 'assertAgentsReadScope')).toBe(false);
  });

  it('ignores angle brackets inside a string literal in the type arguments', () => {
    const source = ".get<{ op: '>' }>(async () => {}).put(async () => {})";
    expect(methodBlocks(source).map(({ method }) => method)).toEqual(['get', 'put']);
  });
});
