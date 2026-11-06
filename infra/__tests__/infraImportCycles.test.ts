// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * sst evaluates infra/ as one esbuild bundle of ES modules. On an import cycle the module that
 * closes it runs while the other is still initialising, so a top-level read of a resource it
 * exports sees undefined and `sst deploy` fails during program evaluation, e.g.
 * `Cannot read properties of undefined (reading 'name')` at infra/web.ts.
 * Typecheck cannot see this, so every value-import cycle in infra/ fails here instead.
 */

const INFRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIPPED_DIRECTORIES = new Set(['__tests__', 'node_modules']);

function listInfraModules(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(entry) ? [] : listInfraModules(path);
    }
    return path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  return [`${base}.ts`, join(base, 'index.ts'), base].find(
    candidate => candidate.endsWith('.ts') && existsSync(candidate)
  );
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    !clause.name &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every(element => element.isTypeOnly)
  );
}

/** Relative modules a file evaluates on load: top-level value imports and re-exports. */
function evaluationTimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false);
  const specifiers = source.statements.flatMap(statement => {
    if (ts.isImportDeclaration(statement) && !isTypeOnlyImport(statement)) return [statement.moduleSpecifier];
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier) {
      return [statement.moduleSpecifier];
    }
    return [];
  });
  return specifiers.flatMap(specifier => {
    if (!ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return [];
    const target = resolveRelative(file, specifier.text);
    return target ? [target] : [];
  });
}

/** Each strongly connected component with more than one module, or a module importing itself. */
function findCycles(graph: Map<string, string[]>): string[][] {
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string) => {
    indexOf.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!indexOf.has(next)) {
        visit(next);
        lowLink.set(node, Math.min(lowLink.get(node)!, lowLink.get(next)!));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node)!, indexOf.get(next)!));
      }
    }
    if (lowLink.get(node) !== indexOf.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) cycles.push(component.sort());
  };

  for (const node of graph.keys()) {
    if (!indexOf.has(node)) visit(node);
  }
  return cycles;
}

function infraImportGraph(): Map<string, string[]> {
  return new Map(listInfraModules(INFRA_ROOT).map(file => [file, evaluationTimeImports(file)]));
}

describe('infra import graph', () => {
  it('has no value-import cycles', () => {
    const cycles = findCycles(infraImportGraph()).map(cycle =>
      cycle.map(file => relative(INFRA_ROOT, file)).join(' <-> ')
    );
    expect(cycles).toEqual([]);
  });

  it('sees the edges the deploy failure ran through', () => {
    const graph = infraImportGraph();
    const edge = (from: string, to: string) => (graph.get(join(INFRA_ROOT, from)) ?? []).includes(join(INFRA_ROOT, to));
    expect(edge('web.ts', 'cron.ts')).toBe(true);
    expect(edge('llmSpendLogGroups.ts', 'web.ts')).toBe(true);
    expect(edge('index.ts', 'cron.ts')).toBe(true);
  });

  it('reports a cycle', () => {
    const graph = new Map([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
      ['d', ['a']],
    ]);
    expect(findCycles(graph)).toEqual([['a', 'b', 'c']]);
  });
});
