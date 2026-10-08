// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { methodBlocks } from './scopeCoverageHelpers';

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

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : tsFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Strips both comment forms so a commented-out `requiredScopes` never counts as a real gate. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Anchors to the `baseApi(...)` call itself so a mention anywhere else cannot satisfy the gate. */
function extractRequiredScopesGate(source: string, prefix: Family['prefix']): string | undefined {
  const gate = new RegExp(
    `baseApi\\(\\{[^}]*requiredScopes:\\s*(${prefix}_(?:READ|WRITE|READ_OR_WRITE)_SCOPES)\\b[^}]*\\}\\)`
  );
  return stripComments(source).match(gate)?.[1];
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
    const gate = extractRequiredScopesGate(rawSource, family.prefix);
    expect(gate, `declare baseApi({ requiredScopes: ${family.prefix}_*_SCOPES })`).toBeDefined();

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
      if (method === 'get') {
        expect(body, `.get on a read-or-write route must assert ${family.dir}:read in-handler`).toMatch(
          new RegExp(`assert${family.assertNoun}ReadScope\\(`)
        );
        continue;
      }
      expect(body, `.${method} on a read-or-write route must assert ${family.dir}:write in-handler`).toMatch(
        new RegExp(`assert${family.assertNoun}WriteScope\\(`)
      );
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
    expect(extractRequiredScopesGate(source, 'PROJECTS')).toBeUndefined();
  });

  it('ignores a requiredScopes mention living only in a comment', () => {
    const source = [
      '// requiredScopes: AGENTS_READ_SCOPES',
      '/* baseApi({ requiredScopes: AGENTS_READ_SCOPES }) */',
      'const handler = baseApi({}).get(async (req, res) => {});',
    ].join('\n');
    expect(extractRequiredScopesGate(source, 'AGENTS')).toBeUndefined();
  });

  it('does not accept the other family scope constant', () => {
    const source = 'const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(async () => {});';
    expect(extractRequiredScopesGate(source, 'AGENTS')).toBeUndefined();
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
});
