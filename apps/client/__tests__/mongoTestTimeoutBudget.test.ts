import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Structural guard for the client shard's real-Mongo suites.
 *
 * A suite that boots a real mongod pays a 16-22s cold start (see MONGO_TEST_TIMEOUT_MS in
 * packages/database/src/__test__/createMongoServer.ts). This shard sets a 30s test budget and
 * inherits a 30s hook budget, both sized for unit tests, so such a suite has under 14s of real
 * headroom and reddens CI at random on a runner sharing cores - a timeout with no failed
 * assertion, green on re-run of the same commit.
 *
 * Auditing that by hand only holds until the next suite is added, so the audit lives here: every
 * real-Mongo suite in this shard must declare the shared budget for its tests AND its hooks, and
 * none may pin itself back with a literal.
 *
 * The checks parse the TypeScript AST rather than matching source text. Regex was tried first and
 * could not carry the invariant: it missed `30_000`, single-line `it(..., 30000)` and Prettier's
 * wrapped `},\n  30000\n)`, while false-positiving on the last line of any multi-line call such as
 * `expect(spy).toHaveBeenCalledWith({\n ... \n}, 2)`. Each `it` reports ALL offenders at once so
 * one run tells you everything to fix.
 */

const CLIENT_ROOT = path.resolve(__dirname, '..');
// Anchored to top-level segments: a nested directory that happens to be called `e2e` holds real
// unit suites and must still be audited (vitest's own `exclude` is a separate glob - keeping this
// list narrow is what stops the two from silently disagreeing).
const SKIP_TOP_LEVEL = new Set(['.next', '.open-next', 'e2e', 'dist', '.turbo']);

// Only an actual import binding counts, so this guard - which names the factories in prose and in
// the identifiers below - never flags itself.
const MONGO_FACTORY_IMPORT = /import\s+\{[^}]*\b(?:createMongoServer|createMongoReplSet)\b[^}]*\}\s*from/;
const SHARED_BUDGET_IMPORT = /import\s+\{[^}]*\bMONGO_TEST_TIMEOUT_MS\b[^}]*\}\s*from/;

const BUDGET_IDENTIFIER = 'MONGO_TEST_TIMEOUT_MS';
const HOOKS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const TESTS_AND_SUITES = new Set(['it', 'test', 'describe']);

type SourceFile = { relativePath: string; source: ts.SourceFile };

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const topLevel = path.relative(CLIENT_ROOT, full).split(path.sep)[0];
      if (entry.name !== 'node_modules' && !SKIP_TOP_LEVEL.has(topLevel)) walk(full, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

// Text-matches to pick the class out of ~1000 files, then parses only the handful that matched.
const realMongoSuites: SourceFile[] = walk(CLIENT_ROOT)
  .reduce<SourceFile[]>((suites, absolutePath) => {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    if (MONGO_FACTORY_IMPORT.test(content)) {
      suites.push({
        relativePath: path.relative(CLIENT_ROOT, absolutePath).split(path.sep).join('/'),
        source: ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true),
      });
    }
    return suites;
  }, [])
  .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

/** Leftmost identifier of a callee, so `it.each([...])(...)` and `describe.only(...)` both read as their base. */
const rootCalleeName = (expression: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootCalleeName(expression.expression);
  if (ts.isCallExpression(expression)) return rootCalleeName(expression.expression);
  return undefined;
};

const forEachCall = (source: ts.SourceFile, visit: (call: ts.CallExpression) => void): void => {
  const recurse = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, recurse);
  };
  ts.forEachChild(source, recurse);
};

const lineOf = (source: ts.SourceFile, node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

const isBudgetIdentifier = (node: ts.Node): boolean => ts.isIdentifier(node) && node.text === BUDGET_IDENTIFIER;

/** `{ timeout: ... }` on a test/suite/hook call, if present. */
const timeoutProperty = (argument: ts.Expression): ts.PropertyAssignment | undefined => {
  if (!ts.isObjectLiteralExpression(argument)) return undefined;
  return argument.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText() === 'timeout'
  );
};

/**
 * Timeout arguments on a test/suite/hook call that are NOT the shared budget - a trailing numeric
 * literal (`it(name, fn, 30000)`, `beforeAll(fn, 30000)`) or a `{ timeout: <literal> }` option.
 */
const offendingTimeouts = (file: SourceFile): string[] => {
  const offenders: string[] = [];

  forEachCall(file.source, call => {
    const callee = rootCalleeName(call.expression);
    if (!callee || (!HOOKS.has(callee) && !TESTS_AND_SUITES.has(callee))) return;

    for (const argument of call.arguments) {
      if (ts.isNumericLiteral(argument)) {
        offenders.push(`${file.relativePath}:${lineOf(file.source, argument)}: ${callee}(..., ${argument.getText()})`);
        continue;
      }
      const timeout = timeoutProperty(argument);
      if (timeout && !isBudgetIdentifier(timeout.initializer)) {
        offenders.push(`${file.relativePath}:${lineOf(file.source, timeout)}: ${callee}(..., ${timeout.getText()})`);
      }
    }
  });

  return offenders;
};

/**
 * The budget the file actually runs on: the LAST `vi.setConfig` wins at runtime, so a file that
 * declares the shared budget up top and narrows it further down is running on the narrow one.
 */
const effectiveSetConfig = (source: ts.SourceFile): ts.ObjectLiteralExpression | undefined => {
  let last: ts.ObjectLiteralExpression | undefined;

  forEachCall(source, call => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'setConfig') return;
    const [argument] = call.arguments;
    if (argument && ts.isObjectLiteralExpression(argument)) last = argument;
  });

  return last;
};

const declaresSharedBudget = (source: ts.SourceFile): boolean => {
  const config = effectiveSetConfig(source);
  if (!config) return false;

  return (['testTimeout', 'hookTimeout'] as const).every(key => {
    const property = config.properties.find(
      (candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) && candidate.name.getText() === key
    );
    return property !== undefined && isBudgetIdentifier(property.initializer);
  });
};

describe('real-Mongo suites in the client shard declare the shared 60s budget', () => {
  it('finds the real-Mongo suites to audit (guards the detector itself)', () => {
    // A broken detector would make every assertion below vacuously pass, so pin the class as
    // non-empty and pin the suite the budget was first raised for.
    expect(realMongoSuites.length).toBeGreaterThan(10);
    expect(realMongoSuites.map(file => file.relativePath)).toContain(
      'server/services/deleteOrganizationTransaction.e2e.test.ts'
    );
  });

  it('imports MONGO_TEST_TIMEOUT_MS rather than inventing a budget', () => {
    const missing = realMongoSuites
      .filter(file => !SHARED_BUDGET_IMPORT.test(file.source.getFullText()))
      .map(file => file.relativePath);

    expect(missing).toEqual([]);
  });

  it('applies the budget to tests AND hooks via the effective vi.setConfig', () => {
    const missing = realMongoSuites.filter(file => !declaresSharedBudget(file.source)).map(file => file.relativePath);

    expect(missing).toEqual([]);
  });

  it('never pins a test, suite or hook back with a literal timeout', () => {
    expect(realMongoSuites.flatMap(offendingTimeouts)).toEqual([]);
  });
});
