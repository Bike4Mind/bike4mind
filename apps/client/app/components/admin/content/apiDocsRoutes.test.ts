// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COOKBOOK_RECIPES } from './apiCookbookContent';
import { getQuickstartContent } from './quickstartContent';

const PAGES_API_DIR = fileURLToPath(new URL('../../../../pages/api', import.meta.url));

// Curls in the cookbook that still call routes which do not exist (or not with that method). They
// predate this guard; drop an entry when its recipe is rewritten - the last test fails until you do.
const KNOWN_BROKEN = new Set([
  'GET /api/sessions',
  'GET /api/sessions/$SESSION_ID/export',
  'POST /api/sessions/import',
  'GET /api/sessions/$SESSION_ID/artifacts',
  'POST /api/api-keys',
  'GET /api/api-keys/$KEY_ID/usage',
  'POST /api/api-keys/$KEY_ID/rotate',
  'DELETE /api/api-keys/$KEY_ID',
]);

const documentedCalls = (content: string): string[] =>
  [...content.matchAll(/curl\b([^\n]*?)"\$B4M_BASE_URL(\/api\/[^"?]+)/g)].map(([, flags, path]) => {
    const method = /-X ([A-Z]+)/.exec(flags)?.[1] ?? 'GET';
    return `${method} ${path}`;
  });

const ALL_CALLS = [
  ...new Set([
    ...documentedCalls(getQuickstartContent('https://b4m.test')),
    ...COOKBOOK_RECIPES.flatMap(recipe => documentedCalls(recipe.content)),
  ]),
];

/** A `$VAR` or `<placeholder>` segment stands for a Next.js `[param]` file or directory. */
const resolveSegment = (dir: string, segment: string, isLast: boolean): string | null => {
  if (!existsSync(dir)) return null;
  const entries = readdirSync(dir);
  const isPlaceholder = segment.startsWith('$') || segment.startsWith('<');
  const matches = entries.filter(entry =>
    isPlaceholder ? entry.startsWith('[') : entry === segment || entry === `${segment}.ts`
  );
  for (const match of matches) {
    const full = join(dir, match);
    if (match.endsWith('.ts')) {
      if (isLast) return full;
    } else if (!isLast) {
      return full;
    } else if (existsSync(join(full, 'index.ts'))) {
      return join(full, 'index.ts');
    }
  }
  return null;
};

const routeFileFor = (path: string): string | null => {
  const segments = path.replace(/^\/api\//, '').split('/');
  let current: string | null = PAGES_API_DIR;
  segments.forEach((segment, i) => {
    if (current) current = resolveSegment(current, segment, i === segments.length - 1);
  });
  return current;
};

const isServed = (call: string): boolean => {
  const [method, path] = call.split(' ');
  const file = routeFileFor(path);
  return !!file && new RegExp(`\\.${method.toLowerCase()}\\(`).test(readFileSync(file, 'utf8'));
};

describe('API Quickstart and Cookbook curls', () => {
  it('finds the documented calls', () => {
    expect(ALL_CALLS).toContain('GET /api/models');
    expect(ALL_CALLS).toContain('POST /api/v1/files');
  });

  it.each(ALL_CALLS.filter(call => !KNOWN_BROKEN.has(call)))('%s is served by a pages/api route', call => {
    expect(isServed(call)).toBe(true);
  });

  it('keeps the known-broken list current', () => {
    for (const call of KNOWN_BROKEN) {
      expect(ALL_CALLS, `${call} is no longer documented`).toContain(call);
      expect(isServed(call), `${call} is now served - remove it from KNOWN_BROKEN`).toBe(false);
    }
  });
});
