// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Invariant: a route that runs a platform-key text completion bills it.
 *
 * A route (or an authoring helper) that builds an LLM backend and calls `.complete(` must reserve
 * and settle credits: through `meterCompletionBackend` / `createRequestCompletionMeter`, or the
 * lower-level `reserveCompletionCredits` / `reserveRequestCredits`. Routes are found by call site, so
 * a new one is held to this without anyone listing it. EXEMPT is the only way out.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');
const AUTHORING_DIR = path.join(__dirname, '..', 'agents', 'authoring');

const COMPLETION = /\bgetOperationsModel\b|\bgetLlmByModel\b|\.complete\(/;
const METER =
  /\b(?:meterCompletionBackend|createRequestCompletionMeter|createCompletionMeter|reserveCompletionCredits|reserveRequestCredits)\b/;

const EXEMPT = new Set([
  'admin/operations-model.ts', // resolves the configured model for display; never completes
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// Drops comment-only lines, JSDoc blocks and trailing comments so a mention in prose is not a call
// site. Anchored on whitespace so a `//` inside a URL string survives.
const stripComments = (src: string) =>
  src
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/[^\n]*/gm, '')
    .replace(/\s\/\/[^\n]*/g, '');

const scan = (dir: string) =>
  sourceFiles(dir).map(f => {
    const src = stripComments(readFileSync(f, 'utf8'));
    return {
      file: path.relative(dir, f).split(path.sep).join('/'),
      completes: COMPLETION.test(src),
      metered: METER.test(src),
    };
  });

const routes = scan(ROUTES_DIR).filter(r => r.completes);
const helpers = scan(AUTHORING_DIR).filter(r =>
  /\.complete\(/.test(readFileSync(path.join(AUTHORING_DIR, r.file), 'utf8'))
);

describe('a platform-key completion is metered', () => {
  it('finds the routes and helpers this ticket metered', () => {
    expect(routes.map(r => r.file)).toEqual(
      expect.arrayContaining([
        'ai/barkeep-chat.ts',
        'ai/tavern-conversation.ts',
        'sessions/[id]/auto-rename.ts',
        'publish/[publicId]/revise.ts',
        'admin/modal-tool.ts',
      ])
    );
    expect(helpers.map(h => h.file).sort()).toEqual([
      'enhanceAgentField.ts',
      'generateAgentAvatar.ts',
      'generateAgentDescription.ts',
      'generateAgentSystemPrompt.ts',
    ]);
  });

  it('meters every completion route that is not exempt', () => {
    expect(routes.filter(r => !r.metered && !EXEMPT.has(r.file)).map(r => r.file)).toEqual([]);
  });

  it('meters every authoring helper', () => {
    expect(helpers.filter(h => !h.metered).map(h => h.file)).toEqual([]);
  });

  it('keeps EXEMPT entries real', () => {
    const files = new Set(routes.map(r => r.file));
    expect([...EXEMPT].filter(e => !files.has(e))).toEqual([]);
  });
});
