/**
 * Guards the package barrel against re-acquiring the LLM tool closure.
 *
 * `@vercel/nft` traces files, not used bindings, so it follows every static import
 * reachable from an entry point regardless of what the importer actually reads. A
 * single `export *` in src/index.ts that reaches llm/tools/index.ts therefore puts
 * every tool implementation and its dependencies (mathjs, isolated-vm, ...) into the
 * Next server bundle for all ~390 apps/client routes that only wanted a plain
 * *Service namespace. Deferring the load with a dynamic `import()` does NOT help:
 * the tracer follows literal-string specifiers at build time either way.
 *
 * The failure mode is silent -- the bundle just grows -- so it needs a test rather
 * than a convention.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(SRC, '../..');
const BARREL = path.join(SRC, 'index.ts');
const TOOL_REGISTRY = path.join(SRC, 'llm/tools/index.ts');

/** Packages that only the tool implementations pull in. Cheap canaries. */
const TOOL_ONLY_PACKAGES = ['mathjs', 'isolated-vm'];

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx', '/index.mts'];

const resolveFile = (base: string): string | null => {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

/** Resolves relative and workspace (@bike4mind/*) specifiers; externals return null. */
const resolveSpecifier = (spec: string, fromFile: string): string | null => {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(fromFile), spec));
  const workspace = spec.match(/^@bike4mind\/([^/]+)(?:\/(.*))?$/);
  if (!workspace) return null;
  const [, pkg, subpath] = workspace;
  const pkgSrc = path.join(CORE, pkg, 'src');
  if (!fs.existsSync(pkgSrc)) return null;
  return resolveFile(subpath ? path.join(pkgSrc, subpath) : path.join(pkgSrc, 'index.ts'));
};

// Comments and their contents must not register as edges.
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// `import type` / `export type` are erased before the tracer runs, so they are not edges.
const EDGE_PATTERNS = [
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const specifiersOf = (file: string): string[] => {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const specs: string[] = [];
  for (const pattern of EDGE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) specs.push(match[1]);
  }
  return specs;
};

type Closure = { files: Set<string>; externals: Set<string>; pathTo: Map<string, string[]> };

const traceFrom = (entry: string): Closure => {
  const files = new Set([entry]);
  const externals = new Set<string>();
  const pathTo = new Map<string, string[]>([[entry, [entry]]]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift() as string;
    const trail = pathTo.get(file) as string[];
    for (const spec of specifiersOf(file)) {
      const resolved = resolveSpecifier(spec, file);
      if (!resolved) {
        if (!spec.startsWith('.')) externals.add(spec.split('/')[0]);
        continue;
      }
      if (files.has(resolved)) continue;
      files.add(resolved);
      pathTo.set(resolved, [...trail, resolved]);
      queue.push(resolved);
    }
  }
  return { files, externals, pathTo };
};

const relative = (file: string) => path.relative(CORE, file);

describe('@bike4mind/services barrel closure', () => {
  const closure = traceFrom(BARREL);

  it('does not reach the LLM tool registry', () => {
    const trail = closure.pathTo.get(TOOL_REGISTRY);
    const chain = trail ? trail.map(relative).join('\n  -> ') : '';
    expect(
      closure.files.has(TOOL_REGISTRY),
      `src/index.ts must not reach llm/tools/index.ts. It now does, via:\n  ${chain}\n` +
        'Import the LLM surface from a subpath instead, or point the offending module at ' +
        'the specific module it needs rather than a barrel.'
    ).toBe(false);
  });

  it.each(TOOL_ONLY_PACKAGES)('does not reach %s', pkg => {
    expect(closure.externals.has(pkg)).toBe(false);
  });

  /**
   * These modules are imported by apps/client code that runs on EVERY API route
   * (baseApi middleware -> toolGearObserver; eventBus -> hundreds of routes). If
   * either stops being a leaf, the tool registry lands back in ~750 route bundles.
   */
  it.each([
    ['llm/toolFinishObserver.ts', 'apps/client baseApi middleware, via toolGearObserver'],
    ['llm/questStartBody.ts', 'apps/client server/utils/eventBus.ts'],
  ])('keeps %s free of the tool registry', module => {
    const closure = traceFrom(path.join(SRC, module));
    const trail = closure.pathTo.get(TOOL_REGISTRY);
    expect(
      closure.files.has(TOOL_REGISTRY),
      `${module} must stay a leaf. It now reaches the tool registry via:\n  ` +
        (trail ? trail.map(relative).join('\n  -> ') : '')
    ).toBe(false);
  });

  it('still reaches the tool registry from the ./llm subpath', () => {
    // Guards the guard: proves the walk can see the registry at all, so the
    // assertions above cannot pass because the traversal silently broke.
    expect(traceFrom(path.join(SRC, 'llm/index.ts')).files.has(TOOL_REGISTRY)).toBe(true);
  });
});
