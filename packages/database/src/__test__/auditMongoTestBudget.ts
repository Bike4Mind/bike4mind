import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Shared auditor for the "a real-Mongo suite declares the shared 60s budget" invariant, consumed
 * by one guard test per shard that owns real-Mongo suites (apps/client, packages/scripts).
 *
 * A suite that boots a real mongod pays a cold start whose cost scales with runner contention -
 * 3-12s per file on a healthy CI run, past 35s on a busy machine (see MONGO_TEST_TIMEOUT_MS in
 * ./createMongoServer). Every shard sets a 30s test budget sized for unit tests, so these suites
 * sit inside that spread and cross it at random: a timeout that asserts nothing and goes green on
 * re-run of the same commit. Declaring MONGO_TEST_TIMEOUT_MS per file is the fix, and this audit
 * is what stops the next suite from being added without it.
 *
 * The checks parse the TypeScript AST rather than matching source text. Regex was tried first and
 * could not carry the invariant: it missed `30_000`, single-line `it(..., 30000)` and Prettier's
 * wrapped `},\n  30000\n)`, while false-positiving on the last line of any multi-line call such as
 * `expect(spy).toHaveBeenCalledWith({\n ... \n}, 2)`. Every offender is collected so one run tells
 * you everything to fix.
 */

// Only an actual import binding counts, so a guard test that names the factories in prose never
// flags itself.
const MONGO_FACTORY_IMPORT = /import\s+\{[^}]*\b(?:createMongoServer|createMongoReplSet)\b[^}]*\}\s*from/;
const SHARED_BUDGET_IMPORT = /import\s+\{[^}]*\bMONGO_TEST_TIMEOUT_MS\b[^}]*\}\s*from/;

const BUDGET_IDENTIFIER = 'MONGO_TEST_TIMEOUT_MS';
const HOOKS = new Set(['beforeAll', 'afterAll', 'beforeEach', 'afterEach']);
const TESTS_AND_SUITES = new Set(['it', 'test', 'describe']);

type SourceFile = { relativePath: string; source: ts.SourceFile };

export type MongoTestBudgetAudit = {
  /** Relative paths of the real-Mongo suites found, sorted. Empty means the detector is broken. */
  suites: string[];
  /** Suites that invent a budget instead of importing the shared one. */
  missingBudgetImport: string[];
  /** Suites whose effective `vi.setConfig` does not apply the budget to both tests and hooks. */
  missingSharedBudget: string[];
  /** `<file>:<line>: <callee>(..., <timeout>)` for each literal timeout pinning a call back. */
  literalTimeouts: string[];
};

const walk = (root: string, dir: string, skipTopLevel: Set<string>, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const topLevel = path.relative(root, full).split(path.sep)[0];
      if (entry.name !== 'node_modules' && !skipTopLevel.has(topLevel)) walk(root, full, skipTopLevel, out);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

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

/**
 * Audits every real-Mongo suite under `root`.
 *
 * `skipTopLevel` names directories to leave out, anchored to top-level segments relative to
 * `root`: a nested directory that happens to share a skipped name (an `e2e` folder holding real
 * unit suites) must still be audited. Keep the list narrow - vitest's own `exclude` is a separate
 * glob, and a broad list here is what lets the two silently disagree.
 */
export const auditMongoTestBudget = ({
  root,
  skipTopLevel = [],
}: {
  root: string;
  skipTopLevel?: readonly string[];
}): MongoTestBudgetAudit => {
  // Text-matches to pick the class out of ~1000 files, then parses only the handful that matched.
  const suites: SourceFile[] = walk(root, root, new Set(skipTopLevel))
    .reduce<SourceFile[]>((matched, absolutePath) => {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      if (MONGO_FACTORY_IMPORT.test(content)) {
        matched.push({
          relativePath: path.relative(root, absolutePath).split(path.sep).join('/'),
          source: ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true),
        });
      }
      return matched;
    }, [])
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    suites: suites.map(file => file.relativePath),
    missingBudgetImport: suites
      .filter(file => !SHARED_BUDGET_IMPORT.test(file.source.getFullText()))
      .map(file => file.relativePath),
    missingSharedBudget: suites.filter(file => !declaresSharedBudget(file.source)).map(file => file.relativePath),
    literalTimeouts: suites.flatMap(offendingTimeouts),
  };
};
