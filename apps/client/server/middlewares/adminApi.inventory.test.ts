import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ADMIN_PERMISSIONS } from '@bike4mind/common';

const routesDirectory = fileURLToPath(new URL('../../pages/api/admin/', import.meta.url));
const credentialRoutes = new Set([
  'emergency-login.ts',
  'rate-limits/ingest.ts',
  'qa/report/[runId]/[token]/[...path].ts',
  ...['attack-simulation', 'cloud-prowler', 'code-semgrep', 'packages', 'secrets', 'web-owasp'].map(
    scanner => `security-dashboard/${scanner}-ingest.ts`
  ),
]);

const listRoutes = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listRoutes(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

const findCall = (tree: ts.SourceFile, matches: (call: ts.CallExpression) => boolean): boolean => {
  const search = (node: ts.Node): boolean =>
    (ts.isCallExpression(node) && matches(node)) || (ts.forEachChild(node, search) ?? false);
  return search(tree);
};

const isFactoryCall = (node: ts.CallExpression, factory: string): boolean =>
  ts.isIdentifier(node.expression) && node.expression.text === factory;

function variableInitializers(tree: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(tree);
  return initializers;
}

/** True when `node` is an `adminApi(...)` call, a method chain on one, or a same-file variable bound to either. */
function isAdminChain(
  node: ts.Expression,
  initializers: Map<string, ts.Expression>,
  resolving: ReadonlySet<string> = new Set()
): boolean {
  if (ts.isIdentifier(node)) {
    const initializer = initializers.get(node.text);
    if (!initializer || resolving.has(node.text)) return false;
    return isAdminChain(initializer, initializers, new Set([...resolving, node.text]));
  }
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'adminApi';
  return (
    ts.isPropertyAccessExpression(node.expression) && isAdminChain(node.expression.expression, initializers, resolving)
  );
}

/** A credential route opts out of session auth with a literal `auth: false` on its baseApi options, not in a comment. */
const disablesSessionAuth = (tree: ts.SourceFile): boolean =>
  findCall(tree, call => {
    const options = call.arguments[0];
    return (
      isFactoryCall(call, 'baseApi') &&
      options !== undefined &&
      ts.isObjectLiteralExpression(options) &&
      options.properties.some(
        property =>
          ts.isPropertyAssignment(property) &&
          property.name.getText(tree) === 'auth' &&
          property.initializer.kind === ts.SyntaxKind.FalseKeyword
      )
    );
  });

function inspectRoute(path: string, source = readFileSync(path, 'utf8')): string[] {
  const route = relative(routesDirectory, path);
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  if (credentialRoutes.has(route)) {
    return disablesSessionAuth(tree) ? [] : [`${route}: credential exception must authenticate independently`];
  }
  const initializers = variableInitializers(tree);
  const declared = new Map<string, string>();
  const served = new Set<string>();
  let wrappers = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isFactoryCall(node, 'adminApi')) {
      wrappers += 1;
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(
          item => ts.isPropertyAssignment(item) && item.name.getText(tree) === 'adminPermissions'
        );
        if (property && ts.isPropertyAssignment(property) && ts.isObjectLiteralExpression(property.initializer)) {
          for (const entry of property.initializer.properties) {
            if (ts.isPropertyAssignment(entry) && ts.isStringLiteral(entry.initializer)) {
              declared.set(entry.name.getText(tree), entry.initializer.text);
            }
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isAdminChain(node.expression.expression, initializers)
    ) {
      const method = node.expression.name.text.toUpperCase();
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) served.add(method);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const failures: string[] = [];
  if (wrappers !== 1) failures.push(`${route}: must use adminApi exactly once`);
  for (const method of served) {
    if (!declared.has(method)) failures.push(`${route}: ${method} has no named permission`);
  }
  for (const [method, permission] of declared) {
    if (!(ADMIN_PERMISSIONS as readonly string[]).includes(permission))
      failures.push(`${route}: unknown permission ${permission}`);
    if (!served.has(method)) failures.push(`${route}: declares unused method ${method}`);
  }
  if (served.size === 0) failures.push(`${route}: no protected HTTP handlers found`);
  return failures;
}

describe('admin route permission inventory', () => {
  it('requires a named permission on every method of every admin route', () => {
    expect(listRoutes(routesDirectory).flatMap(path => inspectRoute(path))).toEqual([]);
  });
  it('fails when a served method loses its permission declaration', () => {
    const path = join(routesDirectory, 'activity-summary.ts');
    const source = readFileSync(path, 'utf8').replace("GET: 'support:read'", '');
    expect(inspectRoute(path, source)).toContain('activity-summary.ts: GET has no named permission');
  });

  it('fails when a route returns to the unguarded baseApi factory', () => {
    const path = join(routesDirectory, 'activity-summary.ts');
    const source = readFileSync(path, 'utf8').replaceAll('adminApi', 'baseApi');
    expect(inspectRoute(path, source)).toContain('activity-summary.ts: must use adminApi exactly once');
  });
});

describe('admin route inventory matcher', () => {
  const fixture = join(routesDirectory, 'fixture.ts');
  const credentialFixture = join(routesDirectory, 'emergency-login.ts');
  const handler = 'async (_req, res) => res.json({})';

  it('accepts handlers served through a variable bound to adminApi', () => {
    const source = `const api = adminApi({ adminPermissions: { GET: 'support:read' } });\nexport default api.get(${handler});`;
    expect(inspectRoute(fixture, source)).toEqual([]);
  });

  it('does not treat a variable named api as admin-guarded when it is bound to baseApi', () => {
    const source = [
      `adminApi({ adminPermissions: { GET: 'support:read' } });`,
      'const api = baseApi();',
      `export default api.get(${handler});`,
    ].join('\n');
    expect(inspectRoute(fixture, source)).toContain('fixture.ts: no protected HTTP handlers found');
  });

  it('exempts a credential route only for a literal auth: false on its baseApi options', () => {
    expect(inspectRoute(credentialFixture, `export default baseApi({ auth: false }).post(${handler});`)).toEqual([]);
    expect(inspectRoute(credentialFixture, `// auth: false\nexport default baseApi().post(${handler});`)).toEqual([
      'emergency-login.ts: credential exception must authenticate independently',
    ]);
  });
});
