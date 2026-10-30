// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Invariant: a moderated user cannot reach an AI feature.
 *
 * A route that runs an LLM, transcription or text refinement for the caller must call a gate that
 * rejects `isModerated` users: `assertAiAccessAllowed` directly, or `createModelAdmission` /
 * `reserveRequestCredits`, which enforce it for the text-LLM and credit-reserving paths.
 *
 * Routes are found by call site, so a new AI route is held to this without anyone listing it. EXEMPT
 * is the only way out, for admin-only routes that need no per-user gate.
 */

// Scanned from outside pages/: an fs-walking test under pages/ is traced as a route and
// pulls the project into the server Lambda (eslint no-restricted-syntax guards it).
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');
const SERVER_DIR = path.join(__dirname, '..');

// `.complete(` catches a route that builds its own LLM backend (rapid-reply, the tavern chats).
const AI_MARKERS = [
  /\bgetOperationsModel\b/,
  /\bgetLlmByModel\b/,
  /\btranscribeUpload\(/,
  /\brefineTextRequest\(/,
  /\.complete\(/,
  /\bSessionEvents\.(?:Summarize|Tag)\.publish\(/,
];
const GATE = /\b(?:assertAiAccessAllowed|createModelAdmission|reserveRequestCredits|aiAccessDeniedMessage)\(/;

const EXEMPT = new Set([
  'admin/modal-tool.ts', // admin
  'admin/operations-model.ts', // admin
  'admin/security-dashboard/ai-assessment.ts', // admin
  'users/counterLogs.ts', // admin
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

const read = (...segments: string[]) => stripComments(readFileSync(path.join(SERVER_DIR, ...segments), 'utf8'));

// A helper that gates internally makes every route calling it gated; derived, not listed.
const selfGatedMarkers = new Set(
  [
    ['transcribe/transcribe.ts', /\btranscribeUpload\(/.source],
    ['ai/refineTextRequest.ts', /\brefineTextRequest\(/.source],
  ].flatMap(([file, marker]) => (GATE.test(read(file)) ? [marker] : []))
);

const routes = sourceFiles(ROUTES_DIR).map(f => {
  const src = stripComments(readFileSync(f, 'utf8'));
  return {
    route: path.relative(ROUTES_DIR, f).split(path.sep).join('/'),
    isAi: AI_MARKERS.some(re => re.test(src)),
    gated: GATE.test(src) || AI_MARKERS.filter(re => re.test(src)).every(re => selfGatedMarkers.has(re.source)),
  };
});
const aiRoutes = routes.filter(r => r.isAi);
const byRoute = new Map(routes.map(r => [r.route, r]));

describe('a moderated user cannot reach an AI feature', () => {
  it('finds the known AI routes', () => {
    expect(aiRoutes.map(r => r.route)).toEqual(
      expect.arrayContaining(['ai/refineText.ts', 'ai/transcribe/index.ts', 'blog/generate-featured-image.ts'])
    );
  });

  it.each(aiRoutes.filter(r => !EXEMPT.has(r.route)).map(r => [r.route, r.gated]))('%s is gated', (route, gated) => {
    expect(
      gated,
      `${route} runs an AI feature but never calls a moderation gate. Call assertAiAccessAllowed(req.user) ` +
        `first in the handler (or go through createModelAdmission / reserveRequestCredits). If it is ` +
        `genuinely admin-only, add it to EXEMPT.`
    ).toBe(true);
  });

  it.each([...EXEMPT])('%s is still an AI route', route => {
    expect(
      byRoute.get(route)?.isAi,
      `${route} no longer exists or no longer matches an AI marker. Remove it from EXEMPT.`
    ).toBe(true);
  });
});
