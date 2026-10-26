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

function isAdminChain(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'api';
  if (!ts.isCallExpression(node)) return false;
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'adminApi';
  return ts.isPropertyAccessExpression(node.expression) && isAdminChain(node.expression.expression);
}

function inspectRoute(path: string, source = readFileSync(path, 'utf8')): string[] {
  const route = relative(routesDirectory, path);
  if (credentialRoutes.has(route)) {
    return source.includes('auth: false') ? [] : [`${route}: credential exception must authenticate independently`];
  }
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const declared = new Map<string, string>();
  const served = new Set<string>();
  let wrappers = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'adminApi') {
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
      isAdminChain(node.expression.expression)
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
